#!/usr/bin/env node

import { Command } from "commander";
import {
  createOctokit,
  fetchPRChangedFiles,
  fetchPRDetails,
  enrichFileChangesWithContent,
  fetchRepoFileContent,
} from "./github";
import { parseConfigFromString } from "./config";
import { inspectChanges, formatChangeSummary } from "./diff-inspector";
import { createNotionClient, fetchPage, findSection } from "./notion";
import { generateDocDiff, LLMConfig } from "./llm";

interface CLIOptions {
  repo: string;
  pr: string;
  githubToken?: string;
  notionToken?: string;
  llmApiKey?: string;
  llmApiUrl?: string;
  llmModel?: string;
  dryRun?: boolean;
}

function getEnvOrFlag(flag: string | undefined, envVar: string): string {
  const value = flag ?? process.env[envVar];
  if (!value) {
    console.error(
      `Missing --${envVar.toLowerCase().replace(/_/g, "-")} flag or ${envVar} environment variable`
    );
    process.exit(1);
  }
  return value;
}

async function run(options: CLIOptions): Promise<void> {
  const [owner, repo] = options.repo.split("/");
  if (!owner || !repo) {
    console.error("--repo must be in format owner/repo");
    process.exit(1);
  }

  const pullNumber = parseInt(options.pr, 10);
  if (isNaN(pullNumber)) {
    console.error("--pr must be a number");
    process.exit(1);
  }

  const githubToken = getEnvOrFlag(options.githubToken, "GITHUB_TOKEN");
  const notionToken = getEnvOrFlag(options.notionToken, "NOTION_TOKEN");
  const llmApiKey = getEnvOrFlag(options.llmApiKey, "LLM_API_KEY");
  const llmApiUrl = getEnvOrFlag(
    options.llmApiUrl,
    "LLM_API_URL"
  );

  const octokit = createOctokit({ token: githubToken });

  console.log(`\nAnalyzing PR #${pullNumber} on ${owner}/${repo}...\n`);

  // Fetch PR details
  const prDetails = await fetchPRDetails(octokit, owner, repo, pullNumber);
  console.log(`  Base: ${prDetails.baseRef} (${prDetails.baseSha.slice(0, 7)})`);
  console.log(`  Head: ${prDetails.headRef} (${prDetails.headSha.slice(0, 7)})\n`);

  // Load config from repo
  const configContent = await fetchRepoFileContent(
    octokit,
    owner,
    repo,
    prDetails.headRef,
    ".specsync.yml"
  );

  if (!configContent) {
    console.error("No .specsync.yml found in repository root.");
    process.exit(1);
  }

  const config = parseConfigFromString(configContent);
  console.log(`  Found ${config.rules.length} rule(s) in .specsync.yml\n`);

  // Fetch and enrich changed files
  const changedFiles = await fetchPRChangedFiles(
    octokit,
    owner,
    repo,
    pullNumber
  );
  console.log(`  PR has ${changedFiles.length} changed file(s)\n`);

  const enrichedFiles = await enrichFileChangesWithContent(
    octokit,
    owner,
    repo,
    changedFiles,
    prDetails.baseSha,
    prDetails.headSha
  );

  // Inspect changes
  const summaries = inspectChanges(enrichedFiles, config.rules);

  if (summaries.length === 0) {
    console.log("  No matching changes found for any rules. Nothing to do.");
    return;
  }

  console.log(`  ${summaries.length} rule(s) matched changes:\n`);

  const llmConfig: LLMConfig = {
    apiKey: llmApiKey,
    apiUrl: llmApiUrl,
    model: options.llmModel ?? process.env["LLM_MODEL"],
  };

  for (let i = 0; i < summaries.length; i++) {
    const summary = summaries[i];
    const changeSummaryText = formatChangeSummary(summary);

    console.log(`${"=".repeat(60)}`);
    console.log(`Rule ${i + 1}: ${summary.rule.doc.section_hint}`);
    console.log(`  Notion page: ${summary.rule.doc.notion_page_id}`);
    console.log(`  Matched files: ${summary.matchedFiles.join(", ")}`);
    console.log(`\n  Change Summary:`);
    console.log(
      changeSummaryText
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n")
    );

    if (options.dryRun) {
      console.log("\n  [Dry run: skipping Notion fetch and LLM generation]\n");
      continue;
    }

    // Fetch Notion page
    try {
      const notionClient = createNotionClient({ token: notionToken });
      const page = await fetchPage(
        notionClient,
        summary.rule.doc.notion_page_id
      );
      console.log(`\n  Notion page: "${page.title}"`);

      const section = findSection(page.blocks, summary.rule.doc.section_hint);
      const currentDocSection = section
        ? section.renderedText
        : "(Section not found; full page used as context)";

      if (section) {
        console.log(`  Found section: "${section.headingText}"`);
        console.log(`  Section content (${section.blocks.length} blocks):\n`);
        console.log(
          currentDocSection
            .split("\n")
            .map((l) => `    ${l}`)
            .join("\n")
        );
      }

      // Generate doc diff
      console.log("\n  Generating LLM doc diff...");
      const docDiff = await generateDocDiff(
        llmConfig,
        changeSummaryText,
        currentDocSection
      );

      console.log(`\n  Explanation: ${docDiff.explanation}`);
      console.log(`\n  Before:`);
      console.log(
        docDiff.before
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n")
      );
      console.log(`\n  After:`);
      console.log(
        docDiff.after
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n")
      );
    } catch (e) {
      console.error(`\n  Error: ${(e as Error).message}`);
    }

    console.log("");
  }

  console.log(`${"=".repeat(60)}`);
  console.log("Done.");
}

const program = new Command();

program
  .name("specsync")
  .description(
    "Analyze a GitHub PR for API/config changes and propose Notion doc updates"
  )
  .requiredOption("--repo <owner/repo>", "GitHub repository (owner/repo)")
  .requiredOption("--pr <number>", "Pull request number")
  .option("--github-token <token>", "GitHub token (or GITHUB_TOKEN env)")
  .option("--notion-token <token>", "Notion token (or NOTION_TOKEN env)")
  .option("--llm-api-key <key>", "LLM API key (or LLM_API_KEY env)")
  .option("--llm-api-url <url>", "LLM API URL (or LLM_API_URL env)")
  .option("--llm-model <model>", "LLM model name")
  .option("--dry-run", "Skip Notion and LLM calls, just show detected changes")
  .action(async (options: CLIOptions) => {
    try {
      await run(options);
    } catch (e) {
      console.error(`Fatal error: ${(e as Error).message}`);
      process.exit(1);
    }
  });

program.parse();
