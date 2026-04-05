/**
 * Shared TypeScript interfaces for SpecSync.
 * Eliminates `as any` casts across the codebase.
 */

// ---- Notion block types ----

export interface RichTextItem {
  type: "text" | "mention" | "equation";
  plain_text: string;
  text?: { content: string; link: { url: string } | null };
  annotations?: {
    bold: boolean;
    italic: boolean;
    strikethrough: boolean;
    underline: boolean;
    code: boolean;
    color: string;
  };
  href: string | null;
}

export interface NotionRichTextBlock {
  rich_text: RichTextItem[];
  color?: string;
}

export interface NotionHeadingBlock extends NotionRichTextBlock {
  is_toggleable: boolean;
}

export interface NotionCodeBlock extends NotionRichTextBlock {
  language: string;
  caption: RichTextItem[];
}

export interface NotionToDoBlock extends NotionRichTextBlock {
  checked: boolean;
}

/**
 * A fully-typed Notion block. The Notion SDK's BlockObjectResponse
 * is a discriminated union; we use a simplified version for the
 * properties we actually access.
 */
export interface TypedNotionBlock {
  id: string;
  type: string;
  paragraph?: NotionRichTextBlock;
  heading_1?: NotionHeadingBlock;
  heading_2?: NotionHeadingBlock;
  heading_3?: NotionHeadingBlock;
  bulleted_list_item?: NotionRichTextBlock;
  numbered_list_item?: NotionRichTextBlock;
  to_do?: NotionToDoBlock;
  toggle?: NotionRichTextBlock;
  code?: NotionCodeBlock;
  quote?: NotionRichTextBlock;
  callout?: NotionRichTextBlock;
  has_children: boolean;
  archived: boolean;
}

// ---- Notion page types ----

export interface NotionTitleProperty {
  type: "title";
  title: RichTextItem[];
}

export interface NotionPageProperties {
  [key: string]: NotionTitleProperty | { type: string; [k: string]: unknown };
}

export interface NotionPage {
  id: string;
  properties: NotionPageProperties;
  url: string;
}

// ---- GitHub types ----

export interface GitHubPR {
  owner: string;
  repo: string;
  pullNumber: number;
  baseSha: string;
  headSha: string;
  baseRef: string;
  headRef: string;
}

export interface PRFile {
  filename: string;
  status: "added" | "removed" | "modified" | "renamed" | "changed" | "copied";
  patch?: string;
  sha: string;
  additions: number;
  deletions: number;
  changes: number;
}

// ---- Change detection types ----

export interface ChangeItem {
  type: "endpoint" | "graphql" | "config";
  changeType: "added" | "removed" | "modified";
  name: string;
  details: string;
}

export interface DocDiff {
  before: string;
  after: string;
  explanation: string;
}

// ---- Config types (re-exported from config.ts for convenience) ----

export interface SpecSyncRule {
  match: {
    path_glob: string;
    file_types: string[];
  };
  doc: {
    notion_page_id: string;
    section_hint: string;
  };
}

export interface SpecSyncConfig {
  rules: SpecSyncRule[];
}

// ---- Rate limiter types ----

export interface RateLimiterOptions {
  maxTokens: number;
  refillRate: number; // tokens per second
  name?: string;
}

// ---- Webhook payload types ----

export interface WebhookPRPayload {
  action: string;
  pull_request: {
    number: number;
    title: string;
    head: { sha: string; ref: string };
    base: { sha: string; ref: string };
  };
  repository: {
    owner: { login: string };
    name: string;
    full_name: string;
  };
}

// ---- LLM types ----

export interface LLMRequestOptions {
  timeout?: number;
  maxRetries?: number;
}

export interface AnthropicResponse {
  content: Array<{ type: string; text: string }>;
}

export interface OpenAIResponse {
  choices: Array<{ message: { content: string } }>;
}
