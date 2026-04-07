import * as fs from "fs";
import * as yaml from "js-yaml";
import { minimatch } from "minimatch";

export interface MatchRule {
  path_glob: string;
  file_types: string[];
}

export interface DocTarget {
  notion_page_id: string;
  section_hint: string;
}

export interface SyncRule {
  match: MatchRule;
  doc: DocTarget;
}

export interface SpecSyncConfig {
  rules: SyncRule[];
}

const VALID_FILE_TYPES = [
  "openapi",
  "graphql",
  "yaml",
  "json",
  "config",
  "swagger",
];

class ConfigValidationError extends Error {
  constructor(message: string) {
    super(`SpecSync config validation error: ${message}`);
    this.name = "ConfigValidationError";
  }
}

function validateRule(rule: unknown, index: number): SyncRule {
  if (typeof rule !== "object" || rule === null) {
    throw new ConfigValidationError(
      `Rule at index ${index} must be an object`
    );
  }

  const r = rule as Record<string, unknown>;

  if (typeof r.match !== "object" || r.match === null) {
    throw new ConfigValidationError(
      `Rule at index ${index} must have a 'match' object`
    );
  }

  if (typeof r.doc !== "object" || r.doc === null) {
    throw new ConfigValidationError(
      `Rule at index ${index} must have a 'doc' object`
    );
  }

  const match = r.match as Record<string, unknown>;
  const doc = r.doc as Record<string, unknown>;

  if (typeof match.path_glob !== "string" || match.path_glob.trim() === "") {
    throw new ConfigValidationError(
      `Rule at index ${index}: match.path_glob must be a non-empty string`
    );
  }

  if (!Array.isArray(match.file_types) || match.file_types.length === 0) {
    throw new ConfigValidationError(
      `Rule at index ${index}: match.file_types must be a non-empty array`
    );
  }

  for (const ft of match.file_types) {
    if (typeof ft !== "string") {
      throw new ConfigValidationError(
        `Rule at index ${index}: each file_type must be a string`
      );
    }
    if (!VALID_FILE_TYPES.includes(ft)) {
      throw new ConfigValidationError(
        `Rule at index ${index}: unknown file_type '${ft}'. Valid types: ${VALID_FILE_TYPES.join(", ")}`
      );
    }
  }

  if (
    typeof doc.notion_page_id !== "string" ||
    doc.notion_page_id.trim() === ""
  ) {
    throw new ConfigValidationError(
      `Rule at index ${index}: doc.notion_page_id must be a non-empty string`
    );
  }

  if (
    typeof doc.section_hint !== "string" ||
    doc.section_hint.trim() === ""
  ) {
    throw new ConfigValidationError(
      `Rule at index ${index}: doc.section_hint must be a non-empty string`
    );
  }

  return {
    match: {
      path_glob: match.path_glob,
      file_types: match.file_types as string[],
    },
    doc: {
      notion_page_id: doc.notion_page_id,
      section_hint: doc.section_hint,
    },
  };
}

export function parseConfigFromString(content: string): SpecSyncConfig {
  const parsed = yaml.load(content);

  if (typeof parsed !== "object" || parsed === null) {
    throw new ConfigValidationError("Config must be a YAML object");
  }

  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj.rules)) {
    throw new ConfigValidationError(
      "Config must have a 'rules' array at the top level"
    );
  }

  if (obj.rules.length === 0) {
    throw new ConfigValidationError("Config must have at least one rule");
  }

  const rules = obj.rules.map((rule: unknown, i: number) =>
    validateRule(rule, i)
  );

  return { rules };
}

export function parseConfigFromFile(filePath: string): SpecSyncConfig {
  if (!fs.existsSync(filePath)) {
    throw new ConfigValidationError(`Config file not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, "utf-8");
  return parseConfigFromString(content);
}

/**
 * Return all rules whose path_glob matches the given filename.
 * Useful as a cheap pre-filter before running the full diff inspector.
 */
export function findRulesForFile(
  config: SpecSyncConfig,
  filename: string
): SyncRule[] {
  return config.rules.filter((rule) =>
    minimatch(filename, rule.match.path_glob, { matchBase: true })
  );
}

/**
 * Return the unique set of Notion doc targets referenced by the given rules.
 *
 * When multiple rules point at the same page + section (e.g. two glob
 * patterns both covering the same OpenAPI file), deduplication prevents
 * fetching and patching the same Notion page twice in a single sync run.
 */
export function getDedupedDocTargets(rules: SyncRule[]): DocTarget[] {
  const seen = new Set<string>();
  const targets: DocTarget[] = [];
  for (const rule of rules) {
    const key = `${rule.doc.notion_page_id}::${rule.doc.section_hint}`;
    if (!seen.has(key)) {
      seen.add(key);
      targets.push(rule.doc);
    }
  }
  return targets;
}

export function parseConfigFromRepo(
  repoRoot: string
): SpecSyncConfig | null {
  const candidates = [
    ".specsync.yml",
    ".specsync.yaml",
    "specsync.yml",
    "specsync.yaml",
  ];

  for (const name of candidates) {
    const fullPath = `${repoRoot}/${name}`;
    if (fs.existsSync(fullPath)) {
      return parseConfigFromFile(fullPath);
    }
  }

  return null;
}
