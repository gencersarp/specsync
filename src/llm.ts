import type { AnthropicResponse, OpenAIResponse } from "./types";

export interface LLMConfig {
  apiKey: string;
  apiUrl: string; // e.g. "https://api.openai.com/v1/chat/completions"
  model?: string;
  /** Request timeout in milliseconds. Default: 30000 */
  timeout?: number;
  /** Max retries on transient failures. Default: 3 */
  maxRetries?: number;
  /** Anthropic API version header. Default: env ANTHROPIC_API_VERSION or "2025-01-01" */
  anthropicApiVersion?: string;
}

export interface DocDiff {
  before: string;
  after: string;
  explanation: string;
}

const SYSTEM_PROMPT = `You are SpecSync, a technical documentation assistant. Your job is to update specification documents to reflect API and configuration changes detected in pull requests.

Rules:
1. Preserve the existing formatting, style, tone, and structure of the document section.
2. Only modify the parts that are directly affected by the detected changes.
3. Do not add commentary or opinions -- only factual documentation of the changes.
4. Keep the same heading structure, bullet style, and terminology conventions.
5. If a new endpoint/field is added, document it in the same style as existing entries.
6. If something is removed, remove its documentation.
7. If something is modified, update its documentation accordingly.

You MUST respond in exactly this JSON format:
{
  "before": "<the original section text that should be replaced>",
  "after": "<the updated section text>",
  "explanation": "<brief human-readable summary of what changed and why>"
}

Only output the JSON object. No markdown fences, no extra text.`;

function buildUserPrompt(
  changeSummary: string,
  currentDocSection: string
): string {
  return `Here is a summary of changes detected in a pull request:

---CHANGES---
${changeSummary}
---END CHANGES---

Here is the current documentation section that may need updating:

---CURRENT DOC---
${currentDocSection}
---END CURRENT DOC---

Analyze the changes and produce an updated version of the documentation section. If no changes are needed, return the section unchanged with an explanation of why no update is needed.`;
}

/**
 * Delay for exponential backoff.
 */
function backoffDelay(attempt: number): number {
  // 1s, 2s, 4s ...
  return Math.min(1000 * Math.pow(2, attempt), 10000);
}

/**
 * Determine if an HTTP status code represents a transient error worth retrying.
 */
function isTransientError(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/**
 * Fetch with timeout support.
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callOpenAICompatible(
  config: LLMConfig,
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  const model = config.model ?? "gpt-4o";
  const timeout = config.timeout ?? 30000;
  const maxRetries = config.maxRetries ?? 3;
  const isAnthropic =
    config.apiUrl.includes("anthropic.com") ||
    config.apiUrl.includes("claude");
  const anthropicVersion =
    config.anthropicApiVersion ??
    process.env["ANTHROPIC_API_VERSION"] ??
    "2025-01-01";

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = backoffDelay(attempt - 1);
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }

    try {
      if (isAnthropic) {
        const response = await fetchWithTimeout(
          config.apiUrl,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": config.apiKey,
              "anthropic-version": anthropicVersion,
            },
            body: JSON.stringify({
              model: config.model ?? "claude-sonnet-4-6",
              max_tokens: 4096,
              temperature: 0.2,
              system: systemPrompt,
              messages: [{ role: "user", content: userPrompt }],
            }),
          },
          timeout
        );

        if (!response.ok) {
          const errBody = await response.text();
          if (isTransientError(response.status) && attempt < maxRetries) {
            lastError = new Error(
              `Anthropic API error ${response.status}: ${errBody}`
            );
            continue;
          }
          throw new Error(
            `Anthropic API error ${response.status}: ${errBody}`
          );
        }

        const data = (await response.json()) as AnthropicResponse;
        const textBlock = data.content.find((c) => c.type === "text");
        return textBlock?.text ?? "";
      }

      // OpenAI-compatible (default)
      const response = await fetchWithTimeout(
        config.apiUrl,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            temperature: 0.2,
            max_tokens: 4096,
          }),
        },
        timeout
      );

      if (!response.ok) {
        const errBody = await response.text();
        if (isTransientError(response.status) && attempt < maxRetries) {
          lastError = new Error(
            `LLM API error ${response.status}: ${errBody}`
          );
          continue;
        }
        throw new Error(
          `LLM API error ${response.status}: ${errBody}`
        );
      }

      const data = (await response.json()) as OpenAIResponse;
      return data.choices?.[0]?.message?.content ?? "";
    } catch (e) {
      const error = e as Error;
      // Retry on network errors (AbortError = timeout, TypeError = network)
      if (
        attempt < maxRetries &&
        (error.name === "AbortError" || error.name === "TypeError")
      ) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  throw lastError ?? new Error("LLM request failed after retries");
}

function parseDocDiffResponse(raw: string): DocDiff {
  // Strip markdown fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  try {
    const parsed = JSON.parse(cleaned);
    if (
      typeof parsed.before !== "string" ||
      typeof parsed.after !== "string" ||
      typeof parsed.explanation !== "string"
    ) {
      throw new Error("Missing required fields");
    }
    return {
      before: parsed.before,
      after: parsed.after,
      explanation: parsed.explanation,
    };
  } catch {
    // If we can't parse structured JSON, create a best-effort response
    return {
      before: "(unable to parse original section)",
      after: cleaned,
      explanation:
        "LLM response was not in expected JSON format. Raw output shown as 'after'.",
    };
  }
}

export async function generateDocDiff(
  config: LLMConfig,
  changeSummary: string,
  currentDocSection: string
): Promise<DocDiff> {
  const userPrompt = buildUserPrompt(changeSummary, currentDocSection);
  const rawResponse = await callOpenAICompatible(
    config,
    SYSTEM_PROMPT,
    userPrompt
  );
  return parseDocDiffResponse(rawResponse);
}

export {
  buildUserPrompt,
  SYSTEM_PROMPT,
  parseDocDiffResponse,
  callOpenAICompatible,
  fetchWithTimeout,
  isTransientError,
  backoffDelay,
};
