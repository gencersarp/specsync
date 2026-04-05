import { Client } from "@notionhq/client";
import type {
  BlockObjectResponse,
  PartialBlockObjectResponse,
} from "@notionhq/client/build/src/api-endpoints";
import { RateLimiter, createNotionRateLimiter } from "./rate-limiter";
import type { TypedNotionBlock, RichTextItem, NotionPageProperties } from "./types";

export interface NotionConfig {
  token: string;
}

export interface NotionSection {
  headingText: string;
  startIndex: number;
  endIndex: number;
  blocks: BlockObjectResponse[];
  renderedText: string;
}

let _rateLimiter: RateLimiter | null = null;

function getRateLimiter(): RateLimiter {
  if (!_rateLimiter) {
    _rateLimiter = createNotionRateLimiter();
  }
  return _rateLimiter;
}

/**
 * Allow tests / callers to inject a custom rate limiter.
 */
export function setNotionRateLimiter(limiter: RateLimiter | null): void {
  _rateLimiter = limiter;
}

function isFullBlock(
  block: BlockObjectResponse | PartialBlockObjectResponse
): block is BlockObjectResponse {
  return "type" in block;
}

function extractRichText(
  richText: Array<{ plain_text: string }>
): string {
  return richText.map((t) => t.plain_text).join("");
}

/**
 * Escape backticks inside code block content to prevent malformed markdown.
 */
function escapeCodeBlockContent(text: string): string {
  return text.replace(/```/g, "\\`\\`\\`");
}

function renderBlock(block: BlockObjectResponse): string {
  const typed = block as unknown as TypedNotionBlock;

  switch (block.type) {
    case "paragraph": {
      const rt = typed.paragraph?.rich_text;
      return rt ? extractRichText(rt) : "";
    }
    case "heading_1": {
      const rt = typed.heading_1?.rich_text;
      return rt ? `# ${extractRichText(rt)}` : "";
    }
    case "heading_2": {
      const rt = typed.heading_2?.rich_text;
      return rt ? `## ${extractRichText(rt)}` : "";
    }
    case "heading_3": {
      const rt = typed.heading_3?.rich_text;
      return rt ? `### ${extractRichText(rt)}` : "";
    }
    case "bulleted_list_item": {
      const rt = typed.bulleted_list_item?.rich_text;
      return rt ? `- ${extractRichText(rt)}` : "- ";
    }
    case "numbered_list_item": {
      const rt = typed.numbered_list_item?.rich_text;
      return rt ? `1. ${extractRichText(rt)}` : "1. ";
    }
    case "to_do": {
      const rt = typed.to_do?.rich_text;
      const checked = typed.to_do?.checked ? "x" : " ";
      return rt ? `- [${checked}] ${extractRichText(rt)}` : `- [${checked}] `;
    }
    case "toggle": {
      const rt = typed.toggle?.rich_text;
      return rt ? `> ${extractRichText(rt)}` : "> ";
    }
    case "code": {
      const rt = typed.code?.rich_text;
      const lang = typed.code?.language || "";
      const text = rt ? escapeCodeBlockContent(extractRichText(rt)) : "";
      return `\`\`\`${lang}\n${text}\n\`\`\``;
    }
    case "quote": {
      const rt = typed.quote?.rich_text;
      return rt ? `> ${extractRichText(rt)}` : "> ";
    }
    case "divider":
      return "---";
    case "callout": {
      const rt = typed.callout?.rich_text;
      return rt ? `> ${extractRichText(rt)}` : "> ";
    }
    case "table_of_contents":
      return "[Table of Contents]";
    default:
      return "";
  }
}

function getHeadingText(block: BlockObjectResponse): string | null {
  const typed = block as unknown as TypedNotionBlock;
  if (block.type === "heading_1") {
    return extractRichText(typed.heading_1?.rich_text ?? []);
  }
  if (block.type === "heading_2") {
    return extractRichText(typed.heading_2?.rich_text ?? []);
  }
  if (block.type === "heading_3") {
    return extractRichText(typed.heading_3?.rich_text ?? []);
  }
  return null;
}

function headingLevel(block: BlockObjectResponse): number {
  if (block.type === "heading_1") return 1;
  if (block.type === "heading_2") return 2;
  if (block.type === "heading_3") return 3;
  return 0;
}

export function createNotionClient(config: NotionConfig): Client {
  return new Client({ auth: config.token });
}

export async function fetchPageBlocks(
  client: Client,
  pageId: string
): Promise<BlockObjectResponse[]> {
  const limiter = getRateLimiter();
  const blocks: BlockObjectResponse[] = [];
  let cursor: string | undefined;

  do {
    await limiter.acquire();
    const response = await client.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 100,
    });

    for (const block of response.results) {
      if (isFullBlock(block)) {
        blocks.push(block);
      }
    }

    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
  } while (cursor);

  return blocks;
}

/**
 * Compute a matching score between a section hint and a heading.
 * Higher is better.
 *
 * Scoring:
 *  - Exact match: 100
 *  - Exact substring (hint in heading or heading in hint): 80 / 60
 *  - Word overlap: requires >= 50% overlap of hint words to score at all
 */
export function computeSectionScore(
  hintLower: string,
  headingLower: string
): number {
  // Exact match
  if (headingLower === hintLower) {
    return 100;
  }

  // Exact substring: heading contains hint
  if (headingLower.includes(hintLower)) {
    return 80;
  }

  // Exact substring: hint contains heading
  if (hintLower.includes(headingLower)) {
    return 60;
  }

  // Word overlap -- require at least 50% of hint words present
  const hintWords = hintLower.split(/\s+/).filter(Boolean);
  const headingWords = new Set(headingLower.split(/\s+/).filter(Boolean));
  const overlap = hintWords.filter((w) => headingWords.has(w)).length;
  const overlapRatio = overlap / Math.max(hintWords.length, 1);

  if (overlapRatio < 0.5) {
    return 0;
  }

  return overlapRatio * 40;
}

export function findSection(
  blocks: BlockObjectResponse[],
  sectionHint: string
): NotionSection | null {
  const hintLower = sectionHint.toLowerCase().trim();

  // Find the heading block that best matches the section hint
  let bestMatchIdx = -1;
  let bestMatchLevel = 0;
  let bestMatchScore = 0;

  for (let i = 0; i < blocks.length; i++) {
    const heading = getHeadingText(blocks[i]);
    if (!heading) continue;

    const headingLower = heading.toLowerCase().trim();
    const score = computeSectionScore(hintLower, headingLower);

    if (score > bestMatchScore) {
      bestMatchScore = score;
      bestMatchIdx = i;
      bestMatchLevel = headingLevel(blocks[i]);
    }
  }

  // Require meaningful match (at least 50% word overlap = score 20, or substring match)
  if (bestMatchIdx === -1 || bestMatchScore < 20) {
    return null;
  }

  // Collect all blocks under this heading until the next heading of same or higher level
  const startIndex = bestMatchIdx;
  let endIndex = blocks.length;

  for (let i = startIndex + 1; i < blocks.length; i++) {
    const level = headingLevel(blocks[i]);
    if (level > 0 && level <= bestMatchLevel) {
      endIndex = i;
      break;
    }
  }

  const sectionBlocks = blocks.slice(startIndex, endIndex);
  const renderedText = renderSection(sectionBlocks);

  return {
    headingText: getHeadingText(blocks[startIndex]) ?? sectionHint,
    startIndex,
    endIndex,
    blocks: sectionBlocks,
    renderedText,
  };
}

export function renderSection(blocks: BlockObjectResponse[]): string {
  return blocks
    .map((b) => renderBlock(b))
    .filter((line) => line !== "")
    .join("\n");
}

export async function fetchPage(
  client: Client,
  pageId: string
): Promise<{ title: string; blocks: BlockObjectResponse[]; url: string }> {
  const limiter = getRateLimiter();
  await limiter.acquire();
  const page = await client.pages.retrieve({ page_id: pageId });
  const blocks = await fetchPageBlocks(client, pageId);

  let title = "Untitled";
  if ("properties" in page) {
    const props = page.properties as NotionPageProperties;
    // Try common title property names
    for (const key of ["title", "Title", "Name", "name"]) {
      const prop = props[key];
      if (
        prop &&
        prop.type === "title" &&
        "title" in prop &&
        Array.isArray(prop.title) &&
        prop.title.length > 0
      ) {
        title = prop.title.map((t: RichTextItem) => t.plain_text).join("");
        break;
      }
    }
  }

  const url = `https://notion.so/${pageId.replace(/-/g, "")}`;

  return { title, blocks, url };
}

// Export internal helpers for testing
export { escapeCodeBlockContent, renderBlock, getHeadingText, headingLevel };
