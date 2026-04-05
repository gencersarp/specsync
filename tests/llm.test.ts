import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildUserPrompt,
  SYSTEM_PROMPT,
  parseDocDiffResponse,
  generateDocDiff,
  isTransientError,
  backoffDelay,
} from "../src/llm";

describe("buildUserPrompt", () => {
  it("includes change summary and current doc section", () => {
    const changes = "API Endpoint Changes:\n  + POST /users: New endpoint";
    const doc = "## Users API\n\nCurrently supports GET /users.";

    const prompt = buildUserPrompt(changes, doc);

    expect(prompt).toContain("---CHANGES---");
    expect(prompt).toContain(changes);
    expect(prompt).toContain("---END CHANGES---");
    expect(prompt).toContain("---CURRENT DOC---");
    expect(prompt).toContain(doc);
    expect(prompt).toContain("---END CURRENT DOC---");
  });

  it("handles empty change summary", () => {
    const prompt = buildUserPrompt("", "Some doc content");
    expect(prompt).toContain("---CHANGES---");
    expect(prompt).toContain("---END CHANGES---");
  });

  it("handles empty doc section", () => {
    const prompt = buildUserPrompt("Some changes", "");
    expect(prompt).toContain("---CURRENT DOC---");
    expect(prompt).toContain("---END CURRENT DOC---");
  });
});

describe("SYSTEM_PROMPT", () => {
  it("instructs the LLM to preserve formatting", () => {
    expect(SYSTEM_PROMPT).toContain("Preserve the existing formatting");
  });

  it("requires JSON output format", () => {
    expect(SYSTEM_PROMPT).toContain('"before"');
    expect(SYSTEM_PROMPT).toContain('"after"');
    expect(SYSTEM_PROMPT).toContain('"explanation"');
  });
});

describe("parseDocDiffResponse", () => {
  it("parses valid JSON response", () => {
    const raw = JSON.stringify({
      before: "## API\n- GET /users",
      after: "## API\n- GET /users\n- POST /users",
      explanation: "Added POST /users endpoint documentation.",
    });

    const result = parseDocDiffResponse(raw);

    expect(result.before).toBe("## API\n- GET /users");
    expect(result.after).toBe("## API\n- GET /users\n- POST /users");
    expect(result.explanation).toBe(
      "Added POST /users endpoint documentation."
    );
  });

  it("strips markdown fences from response", () => {
    const json = {
      before: "old",
      after: "new",
      explanation: "changed",
    };
    const raw = "```json\n" + JSON.stringify(json) + "\n```";

    const result = parseDocDiffResponse(raw);
    expect(result.before).toBe("old");
    expect(result.after).toBe("new");
    expect(result.explanation).toBe("changed");
  });

  it("handles response without json language tag", () => {
    const json = {
      before: "old section",
      after: "new section",
      explanation: "updated",
    };
    const raw = "```\n" + JSON.stringify(json) + "\n```";

    const result = parseDocDiffResponse(raw);
    expect(result.before).toBe("old section");
    expect(result.after).toBe("new section");
  });

  it("falls back gracefully on unparseable response", () => {
    const raw = "This is not JSON at all, just plain text.";

    const result = parseDocDiffResponse(raw);

    expect(result.before).toBe("(unable to parse original section)");
    expect(result.after).toBe(raw);
    expect(result.explanation).toContain("not in expected JSON format");
  });

  it("falls back when JSON is missing required fields", () => {
    const raw = JSON.stringify({ foo: "bar" });

    const result = parseDocDiffResponse(raw);
    expect(result.explanation).toContain("not in expected JSON format");
  });

  it("handles extra whitespace around JSON", () => {
    const json = {
      before: "A",
      after: "B",
      explanation: "C",
    };
    const raw = "  \n  " + JSON.stringify(json) + "  \n  ";

    const result = parseDocDiffResponse(raw);
    expect(result.before).toBe("A");
    expect(result.after).toBe("B");
    expect(result.explanation).toBe("C");
  });

  it("handles empty string response", () => {
    const result = parseDocDiffResponse("");
    expect(result.explanation).toContain("not in expected JSON format");
  });

  it("handles response with only whitespace", () => {
    const result = parseDocDiffResponse("   \n\n  ");
    expect(result.explanation).toContain("not in expected JSON format");
  });

  it("handles response with partial JSON fields", () => {
    const raw = JSON.stringify({ before: "a", after: "b" }); // missing explanation
    const result = parseDocDiffResponse(raw);
    expect(result.explanation).toContain("not in expected JSON format");
  });
});

describe("isTransientError", () => {
  it("identifies rate limit errors", () => {
    expect(isTransientError(429)).toBe(true);
  });

  it("identifies server errors", () => {
    expect(isTransientError(500)).toBe(true);
    expect(isTransientError(502)).toBe(true);
    expect(isTransientError(503)).toBe(true);
    expect(isTransientError(504)).toBe(true);
  });

  it("does not consider 400 as transient", () => {
    expect(isTransientError(400)).toBe(false);
  });

  it("does not consider 401 as transient", () => {
    expect(isTransientError(401)).toBe(false);
  });

  it("does not consider 404 as transient", () => {
    expect(isTransientError(404)).toBe(false);
  });
});

describe("backoffDelay", () => {
  it("returns exponentially increasing delays", () => {
    expect(backoffDelay(0)).toBe(1000);
    expect(backoffDelay(1)).toBe(2000);
    expect(backoffDelay(2)).toBe(4000);
  });

  it("caps at 10 seconds", () => {
    expect(backoffDelay(10)).toBe(10000);
  });
});

describe("generateDocDiff (integration, mocked fetch)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends correct request to OpenAI-compatible API", async () => {
    const mockResponse = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              before: "old",
              after: "new",
              explanation: "updated endpoint docs",
            }),
          },
        },
      ],
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    }) as any;

    const result = await generateDocDiff(
      {
        apiKey: "test-key",
        apiUrl: "https://api.openai.com/v1/chat/completions",
        model: "gpt-4o",
      },
      "Added POST /users",
      "## API\n- GET /users"
    );

    expect(result.before).toBe("old");
    expect(result.after).toBe("new");
    expect(result.explanation).toBe("updated endpoint docs");

    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    expect(fetchCall[0]).toBe(
      "https://api.openai.com/v1/chat/completions"
    );
    const body = JSON.parse(fetchCall[1].body);
    expect(body.model).toBe("gpt-4o");
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].role).toBe("user");
  });

  it("sends correct request to Anthropic API with updated version", async () => {
    const mockResponse = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            before: "old",
            after: "new",
            explanation: "updated",
          }),
        },
      ],
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    }) as any;

    const result = await generateDocDiff(
      {
        apiKey: "test-key",
        apiUrl: "https://api.anthropic.com/v1/messages",
      },
      "changes",
      "doc section"
    );

    expect(result.before).toBe("old");

    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    const headers = fetchCall[1].headers;
    expect(headers["x-api-key"]).toBe("test-key");
    // Verify the updated Anthropic API version
    expect(headers["anthropic-version"]).toBe("2025-01-01");
  });

  it("uses configurable Anthropic API version", async () => {
    const mockResponse = {
      content: [{ type: "text", text: '{"before":"a","after":"b","explanation":"c"}' }],
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    }) as any;

    await generateDocDiff(
      {
        apiKey: "test-key",
        apiUrl: "https://api.anthropic.com/v1/messages",
        anthropicApiVersion: "2024-06-01",
      },
      "changes",
      "doc"
    );

    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    expect(fetchCall[1].headers["anthropic-version"]).toBe("2024-06-01");
  });

  it("retries on transient server errors", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) {
        return {
          ok: false,
          status: 503,
          text: async () => "Service Unavailable",
        };
      }
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: '{"before":"a","after":"b","explanation":"retried successfully"}',
              },
            },
          ],
        }),
      };
    }) as any;

    const result = await generateDocDiff(
      {
        apiKey: "test-key",
        apiUrl: "https://api.openai.com/v1/chat/completions",
        maxRetries: 3,
        timeout: 5000,
      },
      "changes",
      "doc"
    );

    expect(result.explanation).toBe("retried successfully");
    expect(callCount).toBe(3);
  });

  it("throws after exhausting retries", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "Service Unavailable",
    }) as any;

    await expect(
      generateDocDiff(
        {
          apiKey: "test-key",
          apiUrl: "https://api.openai.com/v1/chat/completions",
          maxRetries: 1,
          timeout: 1000,
        },
        "changes",
        "doc"
      )
    ).rejects.toThrow("503");
  });

  it("does not retry on 401 errors", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      return {
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      };
    }) as any;

    await expect(
      generateDocDiff(
        {
          apiKey: "bad-key",
          apiUrl: "https://api.openai.com/v1/chat/completions",
          maxRetries: 3,
          timeout: 1000,
        },
        "changes",
        "doc"
      )
    ).rejects.toThrow("401");

    expect(callCount).toBe(1);
  });

  it("handles timeout via AbortError with retry", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
      callCount++;
      if (callCount <= 1) {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      }
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: '{"before":"a","after":"b","explanation":"recovered from timeout"}',
              },
            },
          ],
        }),
      };
    }) as any;

    const result = await generateDocDiff(
      {
        apiKey: "test-key",
        apiUrl: "https://api.openai.com/v1/chat/completions",
        maxRetries: 2,
        timeout: 100,
      },
      "changes",
      "doc"
    );

    expect(result.explanation).toBe("recovered from timeout");
    expect(callCount).toBe(2);
  });
});
