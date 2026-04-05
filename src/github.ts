import { Octokit } from "@octokit/rest";
import { ChangeSummary, formatChangeSummary } from "./diff-inspector";
import { DocDiff } from "./llm";
import { FileChange } from "./diff-inspector";
import { RateLimiter, createGitHubRateLimiter } from "./rate-limiter";

/**
 * Build a rule-specific bot marker so that each rule gets its own
 * independently-updated comment on the PR.
 *
 * Format: <!-- specsync-bot:RULE_INDEX:NOTION_PAGE_ID -->
 */
function makeBotMarker(ruleIndex: number, notionPageId: string): string {
  return `<!-- specsync-bot:${ruleIndex}:${notionPageId} -->`;
}

export interface GitHubConfig {
  token: string;
}

let _rateLimiter: RateLimiter | null = null;

function getRateLimiter(): RateLimiter {
  if (!_rateLimiter) {
    _rateLimiter = createGitHubRateLimiter();
  }
  return _rateLimiter;
}

/**
 * Allow tests / callers to inject a custom rate limiter.
 */
export function setGitHubRateLimiter(limiter: RateLimiter | null): void {
  _rateLimiter = limiter;
}

export function createOctokit(config: GitHubConfig): Octokit {
  return new Octokit({ auth: config.token });
}

export async function fetchPRChangedFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<FileChange[]> {
  const limiter = getRateLimiter();
  const files: FileChange[] = [];
  let page = 1;

  while (true) {
    await limiter.acquire();
    const response = await octokit.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
      page,
    });

    if (response.data.length === 0) break;

    for (const file of response.data) {
      const statusMap: Record<string, FileChange["status"]> = {
        added: "added",
        removed: "removed",
        modified: "modified",
        renamed: "renamed",
        changed: "modified",
        copied: "added",
      };

      files.push({
        filename: file.filename,
        status: statusMap[file.status] ?? "modified",
        patch: file.patch,
      });
    }

    if (response.data.length < 100) break;
    page++;
  }

  return files;
}

export async function fetchFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<string | undefined> {
  const limiter = getRateLimiter();
  try {
    await limiter.acquire();
    const response = await octokit.repos.getContent({
      owner,
      repo,
      path,
      ref,
    });

    if ("content" in response.data && response.data.type === "file") {
      return Buffer.from(response.data.content, "base64").toString("utf-8");
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function fetchPRDetails(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<{ baseSha: string; headSha: string; baseRef: string; headRef: string }> {
  const limiter = getRateLimiter();
  await limiter.acquire();
  const { data } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });

  return {
    baseSha: data.base.sha,
    headSha: data.head.sha,
    baseRef: data.base.ref,
    headRef: data.head.ref,
  };
}

export async function enrichFileChangesWithContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  files: FileChange[],
  baseSha: string,
  headSha: string
): Promise<FileChange[]> {
  const enriched: FileChange[] = [];

  for (const file of files) {
    const enrichedFile = { ...file };

    if (file.status !== "added") {
      enrichedFile.beforeContent = await fetchFileContent(
        octokit,
        owner,
        repo,
        file.filename,
        baseSha
      );
    }

    if (file.status !== "removed") {
      enrichedFile.afterContent = await fetchFileContent(
        octokit,
        owner,
        repo,
        file.filename,
        headSha
      );
    }

    enriched.push(enrichedFile);
  }

  return enriched;
}

function buildCommentBody(
  ruleIndex: number,
  notionPageId: string,
  docTitle: string,
  notionUrl: string,
  summary: ChangeSummary,
  docDiff: DocDiff
): string {
  const marker = makeBotMarker(ruleIndex, notionPageId);
  const changeLines: string[] = [];

  for (const ep of summary.endpoints) {
    const verb =
      ep.changeType === "added"
        ? "Added"
        : ep.changeType === "removed"
          ? "Removed"
          : "Modified";
    changeLines.push(`- **${verb}** \`${ep.method} ${ep.path}\`: ${ep.details}`);
  }

  for (const gc of summary.graphqlChanges) {
    const verb =
      gc.changeType === "added"
        ? "Added"
        : gc.changeType === "removed"
          ? "Removed"
          : "Modified";
    changeLines.push(`- **${verb}** ${gc.kind} \`${gc.name}\`: ${gc.details}`);
  }

  for (const cc of summary.configChanges) {
    const verb =
      cc.changeType === "added"
        ? "Added"
        : cc.changeType === "removed"
          ? "Removed"
          : "Modified";
    if (cc.changeType === "modified") {
      changeLines.push(
        `- **${verb}** config key \`${cc.key}\`: \`${cc.oldValue}\` -> \`${cc.newValue}\``
      );
    } else if (cc.changeType === "added") {
      changeLines.push(
        `- **${verb}** config key \`${cc.key}\`: \`${cc.newValue}\``
      );
    } else {
      changeLines.push(
        `- **${verb}** config key \`${cc.key}\``
      );
    }
  }

  // Escape backticks in before/after text to prevent breaking markdown
  const escapedBefore = docDiff.before.replace(/```/g, "\\`\\`\\`");
  const escapedAfter = docDiff.after.replace(/```/g, "\\`\\`\\`");

  return `${marker}
## SpecSync: Proposed updates for **${docTitle}**

[View Notion page](${notionUrl})

### Detected Changes

${changeLines.join("\n")}

**Matched files:** ${summary.matchedFiles.map((f) => `\`${f}\``).join(", ")}

### Explanation

${docDiff.explanation}

<details>
<summary>Suggested documentation update (click to expand)</summary>

**Current section:**
\`\`\`
${escapedBefore}
\`\`\`

**Proposed update:**
\`\`\`
${escapedAfter}
\`\`\`

</details>

---
*AI-generated suggestion; please review before applying. Generated by SpecSync.*`;
}

async function findExistingComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  ruleIndex: number,
  notionPageId: string
): Promise<number | null> {
  const limiter = getRateLimiter();
  const marker = makeBotMarker(ruleIndex, notionPageId);
  let page = 1;

  while (true) {
    await limiter.acquire();
    const { data: comments } = await octokit.issues.listComments({
      owner,
      repo,
      issue_number: pullNumber,
      per_page: 100,
      page,
    });

    if (comments.length === 0) break;

    for (const comment of comments) {
      if (comment.body?.includes(marker)) {
        return comment.id;
      }
    }

    if (comments.length < 100) break;
    page++;
  }

  return null;
}

export async function postOrUpdateComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  ruleIndex: number,
  notionPageId: string,
  docTitle: string,
  notionUrl: string,
  summary: ChangeSummary,
  docDiff: DocDiff
): Promise<string> {
  const limiter = getRateLimiter();
  const body = buildCommentBody(ruleIndex, notionPageId, docTitle, notionUrl, summary, docDiff);

  const existingCommentId = await findExistingComment(
    octokit,
    owner,
    repo,
    pullNumber,
    ruleIndex,
    notionPageId
  );

  if (existingCommentId) {
    await limiter.acquire();
    const { data } = await octokit.issues.updateComment({
      owner,
      repo,
      comment_id: existingCommentId,
      body,
    });
    return data.html_url;
  }

  await limiter.acquire();
  const { data } = await octokit.issues.createComment({
    owner,
    repo,
    issue_number: pullNumber,
    body,
  });
  return data.html_url;
}

/**
 * Post an error comment on a PR for a specific rule.
 */
export async function postErrorComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  ruleIndex: number,
  notionPageId: string,
  errorMessage: string
): Promise<string> {
  const limiter = getRateLimiter();
  const marker = makeBotMarker(ruleIndex, notionPageId);
  const body = `${marker}
## SpecSync: Error processing rule

An error occurred while processing the sync rule for Notion page \`${notionPageId}\`:

\`\`\`
${errorMessage}
\`\`\`

---
*This error was reported by SpecSync. Check server logs for more details.*`;

  const existingCommentId = await findExistingComment(
    octokit,
    owner,
    repo,
    pullNumber,
    ruleIndex,
    notionPageId
  );

  if (existingCommentId) {
    await limiter.acquire();
    const { data } = await octokit.issues.updateComment({
      owner,
      repo,
      comment_id: existingCommentId,
      body,
    });
    return data.html_url;
  }

  await limiter.acquire();
  const { data } = await octokit.issues.createComment({
    owner,
    repo,
    issue_number: pullNumber,
    body,
  });
  return data.html_url;
}

export async function fetchRepoFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  path: string
): Promise<string | null> {
  const content = await fetchFileContent(octokit, owner, repo, path, ref);
  return content ?? null;
}

// Export for testing
export { makeBotMarker, buildCommentBody, findExistingComment };
