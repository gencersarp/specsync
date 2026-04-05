import * as crypto from "crypto";
import type { Request, Response } from "express";
import {
  createOctokit,
  fetchPRChangedFiles,
  fetchPRDetails,
  enrichFileChangesWithContent,
  postOrUpdateComment,
  postErrorComment,
  fetchRepoFileContent,
} from "./github";
import { parseConfigFromString, SyncRule } from "./config";
import { inspectChanges, formatChangeSummary, ChangeSummary } from "./diff-inspector";
import { createNotionClient, fetchPage, findSection } from "./notion";
import { generateDocDiff, LLMConfig } from "./llm";

export interface WebhookEnv {
  githubAppId: string;
  githubPrivateKey: string;
  githubWebhookSecret: string;
  githubToken: string;
  notionToken: string;
  llmApiKey: string;
  llmApiUrl: string;
  llmModel?: string;
}

/**
 * Express request extended with rawBody for webhook signature verification.
 */
interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

export function verifyWebhookSignature(
  payload: string | Buffer,
  signature: string | undefined,
  secret: string
): boolean {
  if (!signature) return false;

  const payloadStr =
    typeof payload === "string" ? payload : payload.toString("utf-8");
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(payloadStr).digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

interface RuleResult {
  ruleIndex: number;
  notionPageId: string;
  success: boolean;
  error?: string;
}

async function processRule(
  ruleIndex: number,
  summary: ChangeSummary,
  octokit: ReturnType<typeof createOctokit>,
  owner: string,
  repo: string,
  pullNumber: number,
  env: WebhookEnv,
  llmConfig: LLMConfig
): Promise<RuleResult> {
  const notionPageId = summary.rule.doc.notion_page_id;

  try {
    // Fetch Notion page
    const notionClient = createNotionClient({ token: env.notionToken });
    const page = await fetchPage(notionClient, notionPageId);

    // Find relevant section
    const section = findSection(page.blocks, summary.rule.doc.section_hint);
    const currentDocSection = section
      ? section.renderedText
      : `(Section "${summary.rule.doc.section_hint}" not found in Notion page. Full page content will be used as context.)\n\n${page.blocks.length} blocks in page.`;

    // Generate doc diff via LLM
    const changeSummaryText = formatChangeSummary(summary);
    const docDiff = await generateDocDiff(
      llmConfig,
      changeSummaryText,
      currentDocSection
    );

    // Post or update comment (per-rule marker)
    await postOrUpdateComment(
      octokit,
      owner,
      repo,
      pullNumber,
      ruleIndex,
      notionPageId,
      page.title,
      page.url,
      summary,
      docDiff
    );

    return { ruleIndex, notionPageId, success: true };
  } catch (e) {
    const errorMessage = (e as Error).message;

    // Post error as PR comment (Fix #9: report errors to PR)
    try {
      await postErrorComment(
        octokit,
        owner,
        repo,
        pullNumber,
        ruleIndex,
        notionPageId,
        errorMessage
      );
    } catch (commentError) {
      console.error(
        `Failed to post error comment for rule ${ruleIndex}:`,
        (commentError as Error).message
      );
    }

    return { ruleIndex, notionPageId, success: false, error: errorMessage };
  }
}

async function processPR(
  owner: string,
  repo: string,
  pullNumber: number,
  env: WebhookEnv
): Promise<{ processed: number; errors: string[] }> {
  const octokit = createOctokit({ token: env.githubToken });
  const errors: string[] = [];
  let processed = 0;

  // 1. Fetch PR details
  const prDetails = await fetchPRDetails(octokit, owner, repo, pullNumber);

  // 2. Try to load .specsync.yml from repo
  const configContent = await fetchRepoFileContent(
    octokit,
    owner,
    repo,
    prDetails.headRef,
    ".specsync.yml"
  );

  if (!configContent) {
    return { processed: 0, errors: ["No .specsync.yml found in repository"] };
  }

  let rules: SyncRule[];
  try {
    const config = parseConfigFromString(configContent);
    rules = config.rules;
  } catch (e) {
    return {
      processed: 0,
      errors: [`Invalid .specsync.yml: ${(e as Error).message}`],
    };
  }

  // 3. Fetch changed files and enrich with content
  const changedFiles = await fetchPRChangedFiles(
    octokit,
    owner,
    repo,
    pullNumber
  );

  const enrichedFiles = await enrichFileChangesWithContent(
    octokit,
    owner,
    repo,
    changedFiles,
    prDetails.baseSha,
    prDetails.headSha
  );

  // 4. Inspect changes against rules
  const summaries = inspectChanges(enrichedFiles, rules);

  if (summaries.length === 0) {
    return { processed: 0, errors: [] };
  }

  // 5. Process each rule independently (Fix #10: multi-rule handling)
  const llmConfig: LLMConfig = {
    apiKey: env.llmApiKey,
    apiUrl: env.llmApiUrl,
    model: env.llmModel,
  };

  // Process all rules, collecting results
  const results: RuleResult[] = [];
  for (let i = 0; i < summaries.length; i++) {
    const result = await processRule(
      i,
      summaries[i],
      octokit,
      owner,
      repo,
      pullNumber,
      env,
      llmConfig
    );
    results.push(result);
  }

  for (const result of results) {
    if (result.success) {
      processed++;
    } else if (result.error) {
      errors.push(
        `Error processing rule ${result.ruleIndex} for ${result.notionPageId}: ${result.error}`
      );
    }
  }

  return { processed, errors };
}

export async function handleWebhook(
  req: Request,
  res: Response,
  env: WebhookEnv
): Promise<void> {
  const rawReq = req as RawBodyRequest;

  // Verify signature using raw body bytes
  const signature = req.headers["x-hub-signature-256"] as string | undefined;
  const rawBody = rawReq.rawBody
    ? rawReq.rawBody
    : typeof req.body === "string"
      ? req.body
      : JSON.stringify(req.body);

  if (!verifyWebhookSignature(rawBody, signature, env.githubWebhookSecret)) {
    res.status(401).json({ error: "Invalid webhook signature" });
    return;
  }

  const event = req.headers["x-github-event"] as string;
  const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

  // Only handle PR events
  if (event !== "pull_request") {
    res.status(200).json({ message: "Event ignored", event });
    return;
  }

  const action = payload.action as string;
  if (action !== "opened" && action !== "synchronize") {
    res.status(200).json({ message: "Action ignored", action });
    return;
  }

  const owner = payload.repository?.owner?.login as string;
  const repo = payload.repository?.name as string;
  const pullNumber = payload.pull_request?.number as number;

  if (!owner || !repo || !pullNumber) {
    res.status(400).json({ error: "Missing PR info in payload" });
    return;
  }

  // Respond quickly, process in background
  res.status(202).json({ message: "Processing", owner, repo, pullNumber });

  try {
    const result = await processPR(owner, repo, pullNumber, env);
    console.log(
      `SpecSync processed PR #${pullNumber} on ${owner}/${repo}: ${result.processed} rules applied, ${result.errors.length} errors`
    );
    if (result.errors.length > 0) {
      console.error("Errors:", result.errors);
    }
  } catch (e) {
    console.error(
      `SpecSync failed for PR #${pullNumber} on ${owner}/${repo}:`,
      e
    );
    // Attempt to post a top-level error comment
    try {
      const octokit = createOctokit({ token: env.githubToken });
      await postErrorComment(
        octokit,
        owner,
        repo,
        pullNumber,
        -1,
        "global",
        `SpecSync encountered an unexpected error: ${(e as Error).message}`
      );
    } catch {
      // Best effort
    }
  }
}

// Export processPR for CLI usage
export { processPR };
