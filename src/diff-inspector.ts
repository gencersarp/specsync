import * as yaml from "js-yaml";
import { minimatch } from "minimatch";
import { SyncRule } from "./config";

// ---- Types ----

export interface FileChange {
  filename: string;
  status: "added" | "modified" | "removed" | "renamed";
  patch?: string;
  beforeContent?: string;
  afterContent?: string;
}

export interface EndpointChange {
  method: string;
  path: string;
  changeType: "added" | "removed" | "modified";
  details: string;
}

export interface GraphQLChange {
  name: string;
  kind: "query" | "mutation" | "type" | "input" | "enum" | "subscription" | "interface" | "directive" | "schema";
  changeType: "added" | "removed" | "modified";
  details: string;
  /** For field-level granularity within types */
  fieldChanges?: FieldChange[];
}

export interface FieldChange {
  fieldName: string;
  changeType: "added" | "removed" | "modified";
  details: string;
}

export interface ConfigChange {
  key: string;
  changeType: "added" | "removed" | "modified";
  oldValue?: string;
  newValue?: string;
}

export interface ChangeSummary {
  rule: SyncRule;
  matchedFiles: string[];
  endpoints: EndpointChange[];
  graphqlChanges: GraphQLChange[];
  configChanges: ConfigChange[];
  rawPatches: string[];
}

// ---- File type detection ----

function detectFileType(
  filename: string
): "openapi" | "graphql" | "yaml" | "json" | "unknown" {
  const lower = filename.toLowerCase();
  if (
    lower.endsWith(".graphql") ||
    lower.endsWith(".gql") ||
    lower.endsWith(".graphqls")
  ) {
    return "graphql";
  }
  if (lower.endsWith(".json")) {
    return "json";
  }
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) {
    return "yaml";
  }
  return "unknown";
}

function isOpenAPIContent(content: string): boolean {
  try {
    const parsed =
      content.trim().startsWith("{") ? JSON.parse(content) : yaml.load(content);
    if (typeof parsed !== "object" || parsed === null) return false;
    const obj = parsed as Record<string, unknown>;
    return (
      typeof obj.openapi === "string" ||
      typeof obj.swagger === "string" ||
      typeof obj.paths === "object"
    );
  } catch {
    return false;
  }
}

// ---- OpenAPI parsing ----

interface OpenAPIPaths {
  [path: string]: {
    [method: string]: unknown;
  };
}

function extractOpenAPIEndpoints(
  content: string
): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  try {
    const parsed = content.trim().startsWith("{")
      ? JSON.parse(content)
      : (yaml.load(content) as Record<string, unknown>);
    const paths = (parsed as Record<string, unknown>).paths as
      | OpenAPIPaths
      | undefined;
    if (!paths) return map;

    for (const [path, methods] of Object.entries(paths)) {
      if (typeof methods !== "object" || methods === null) continue;
      for (const [method, spec] of Object.entries(methods)) {
        if (
          ["get", "post", "put", "patch", "delete", "head", "options"].includes(
            method.toLowerCase()
          )
        ) {
          const key = `${method.toUpperCase()} ${path}`;
          map.set(key, (spec as Record<string, unknown>) ?? {});
        }
      }
    }
  } catch {
    // parse failure, return empty
  }
  return map;
}

function diffOpenAPI(
  beforeContent: string | undefined,
  afterContent: string | undefined
): EndpointChange[] {
  const changes: EndpointChange[] = [];
  const before = beforeContent
    ? extractOpenAPIEndpoints(beforeContent)
    : new Map<string, Record<string, unknown>>();
  const after = afterContent
    ? extractOpenAPIEndpoints(afterContent)
    : new Map<string, Record<string, unknown>>();

  // Find added/modified endpoints
  for (const [key, afterSpec] of after) {
    const [method, ...pathParts] = key.split(" ");
    const path = pathParts.join(" ");
    if (!before.has(key)) {
      changes.push({
        method,
        path,
        changeType: "added",
        details: summarizeEndpoint(afterSpec),
      });
    } else {
      const beforeSpec = before.get(key)!;
      const beforeStr = JSON.stringify(beforeSpec);
      const afterStr = JSON.stringify(afterSpec);
      if (beforeStr !== afterStr) {
        changes.push({
          method,
          path,
          changeType: "modified",
          details: describeEndpointDiff(beforeSpec, afterSpec),
        });
      }
    }
  }

  // Find removed endpoints
  for (const [key] of before) {
    if (!after.has(key)) {
      const [method, ...pathParts] = key.split(" ");
      const path = pathParts.join(" ");
      changes.push({
        method,
        path,
        changeType: "removed",
        details: "Endpoint removed",
      });
    }
  }

  return changes;
}

function summarizeEndpoint(spec: Record<string, unknown>): string {
  const parts: string[] = [];
  if (spec.summary) parts.push(`Summary: ${spec.summary}`);
  if (spec.operationId) parts.push(`Operation: ${spec.operationId}`);
  if (Array.isArray(spec.parameters)) {
    const paramNames = spec.parameters.map(
      (p: Record<string, unknown>) => `${p.name}(${p.in})`
    );
    parts.push(`Parameters: ${paramNames.join(", ")}`);
  }
  if (spec.requestBody) parts.push("Has request body");
  if (spec.responses) {
    const codes = Object.keys(spec.responses as Record<string, unknown>);
    parts.push(`Response codes: ${codes.join(", ")}`);
  }
  return parts.length > 0 ? parts.join("; ") : "New endpoint";
}

function describeEndpointDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): string {
  const diffs: string[] = [];

  if (JSON.stringify(before.parameters) !== JSON.stringify(after.parameters)) {
    const beforeParams = Array.isArray(before.parameters)
      ? (before.parameters as Array<Record<string, unknown>>).map(
          (p) => p.name as string
        )
      : [];
    const afterParams = Array.isArray(after.parameters)
      ? (after.parameters as Array<Record<string, unknown>>).map(
          (p) => p.name as string
        )
      : [];
    const added = afterParams.filter((p) => !beforeParams.includes(p));
    const removed = beforeParams.filter((p) => !afterParams.includes(p));
    if (added.length) diffs.push(`Added params: ${added.join(", ")}`);
    if (removed.length) diffs.push(`Removed params: ${removed.join(", ")}`);
    if (added.length === 0 && removed.length === 0)
      diffs.push("Parameters modified");
  }

  if (
    JSON.stringify(before.requestBody) !== JSON.stringify(after.requestBody)
  ) {
    diffs.push("Request body modified");
  }

  if (JSON.stringify(before.responses) !== JSON.stringify(after.responses)) {
    diffs.push("Response schema modified");
  }

  if (before.summary !== after.summary) diffs.push("Summary changed");
  if (before.description !== after.description)
    diffs.push("Description changed");

  return diffs.length > 0 ? diffs.join("; ") : "Endpoint modified";
}

// ---- GraphQL SDL parsing (enhanced) ----

interface GraphQLField {
  name: string;
  definition: string;
}

interface GraphQLDefinition {
  kind: string;
  name: string;
  body: string;
  fields: GraphQLField[];
}

/**
 * Extract fields from a GraphQL type body.
 * Each field is a line like `fieldName(args): Type` or `ENUM_VALUE`.
 */
function parseGraphQLFields(body: string): GraphQLField[] {
  const fields: GraphQLField[] = [];
  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("\"\"\""));

  for (const line of lines) {
    const name = line.split(/[:(,\s]/)[0].trim();
    if (name) {
      fields.push({ name, definition: line });
    }
  }

  return fields;
}

/**
 * Balance braces to extract the full body of a definition, handling nested braces.
 */
function extractBalancedBody(content: string, startIdx: number): { body: string; endIdx: number } | null {
  let braceCount = 0;
  let bodyStart = -1;

  for (let i = startIdx; i < content.length; i++) {
    if (content[i] === "{") {
      if (braceCount === 0) {
        bodyStart = i + 1;
      }
      braceCount++;
    } else if (content[i] === "}") {
      braceCount--;
      if (braceCount === 0) {
        return {
          body: content.slice(bodyStart, i).trim(),
          endIdx: i + 1,
        };
      }
    }
  }

  return null;
}

function parseGraphQLDefinitions(content: string): GraphQLDefinition[] {
  const defs: GraphQLDefinition[] = [];

  // Pattern for standard type definitions:
  // type, input, enum, scalar, union, interface, subscription
  const typePattern =
    /\b(type|input|enum|scalar|union|interface)\s+(\w+)/g;

  let match: RegExpExecArray | null;
  while ((match = typePattern.exec(content)) !== null) {
    // Check if preceded by "extend " (we handle extend separately)
    const precedingChars = content.slice(Math.max(0, match.index - 7), match.index);
    if (precedingChars.includes("extend")) continue;

    const kind = match[1];
    const name = match[2];
    const result = extractBalancedBody(content, match.index);

    if (result) {
      const fields = parseGraphQLFields(result.body);
      defs.push({ kind, name, body: result.body, fields });
    } else if (kind === "scalar" || kind === "union") {
      // Scalars and unions might not have braces
      defs.push({ kind, name, body: "", fields: [] });
    }
  }

  // Pattern for extend type/input/enum/interface blocks
  const extendPattern =
    /\bextend\s+(type|input|enum|interface)\s+(\w+)/g;
  while ((match = extendPattern.exec(content)) !== null) {
    const kind = `extend_${match[1]}`;
    const name = match[2];
    const result = extractBalancedBody(content, match.index);

    if (result) {
      const fields = parseGraphQLFields(result.body);
      defs.push({ kind, name, body: result.body, fields });
    }
  }

  // Pattern for directive definitions
  const directivePattern =
    /\bdirective\s+@(\w+)/g;
  while ((match = directivePattern.exec(content)) !== null) {
    const name = match[1];
    // Directive might have arguments in parens and `on` clause
    const rest = content.slice(match.index);
    const onMatch = rest.match(/on\s+([A-Z_|,\s]+)/);
    const locations = onMatch ? onMatch[1].trim() : "";
    defs.push({
      kind: "directive",
      name,
      body: locations,
      fields: [],
    });
  }

  // Pattern for schema { ... } blocks
  const schemaPattern = /\bschema\s*\{/g;
  while ((match = schemaPattern.exec(content)) !== null) {
    // Check not preceded by "extend"
    const precedingChars = content.slice(Math.max(0, match.index - 7), match.index);
    if (precedingChars.includes("extend")) continue;

    const result = extractBalancedBody(content, match.index);
    if (result) {
      const fields = parseGraphQLFields(result.body);
      defs.push({ kind: "schema", name: "schema", body: result.body, fields });
    }
  }

  return defs;
}

function mapGraphQLKind(
  kind: string
): GraphQLChange["kind"] {
  const k = kind.replace("extend_", "").toLowerCase();
  switch (k) {
    case "query":
    case "mutation":
    case "subscription":
      return k as "query" | "mutation" | "subscription";
    case "input":
      return "input";
    case "enum":
      return "enum";
    case "interface":
      return "interface";
    case "directive":
      return "directive";
    case "schema":
      return "schema";
    default:
      return "type";
  }
}

/**
 * Compute field-level diff between two type bodies.
 */
function diffGraphQLFields(
  beforeFields: GraphQLField[],
  afterFields: GraphQLField[]
): FieldChange[] {
  const changes: FieldChange[] = [];
  const beforeMap = new Map(beforeFields.map((f) => [f.name, f]));
  const afterMap = new Map(afterFields.map((f) => [f.name, f]));

  for (const [name, afterField] of afterMap) {
    if (!beforeMap.has(name)) {
      changes.push({
        fieldName: name,
        changeType: "added",
        details: `Added field: ${afterField.definition}`,
      });
    } else {
      const beforeField = beforeMap.get(name)!;
      if (beforeField.definition !== afterField.definition) {
        changes.push({
          fieldName: name,
          changeType: "modified",
          details: `Changed: ${beforeField.definition} -> ${afterField.definition}`,
        });
      }
    }
  }

  for (const [name, beforeField] of beforeMap) {
    if (!afterMap.has(name)) {
      changes.push({
        fieldName: name,
        changeType: "removed",
        details: `Removed field: ${beforeField.definition}`,
      });
    }
  }

  return changes;
}

function diffGraphQL(
  beforeContent: string | undefined,
  afterContent: string | undefined
): GraphQLChange[] {
  const changes: GraphQLChange[] = [];
  const beforeDefs = beforeContent ? parseGraphQLDefinitions(beforeContent) : [];
  const afterDefs = afterContent ? parseGraphQLDefinitions(afterContent) : [];

  const beforeMap = new Map<string, GraphQLDefinition>();
  for (const d of beforeDefs) beforeMap.set(`${d.kind}:${d.name}`, d);

  const afterMap = new Map<string, GraphQLDefinition>();
  for (const d of afterDefs) afterMap.set(`${d.kind}:${d.name}`, d);

  for (const [key, afterDef] of afterMap) {
    if (!beforeMap.has(key)) {
      changes.push({
        name: afterDef.name,
        kind: mapGraphQLKind(afterDef.kind),
        changeType: "added",
        details: `New ${afterDef.kind} with fields: ${summarizeGraphQLBody(afterDef.body)}`,
      });
    } else {
      const beforeDef = beforeMap.get(key)!;
      if (beforeDef.body !== afterDef.body) {
        const fieldChanges = diffGraphQLFields(beforeDef.fields, afterDef.fields);
        const details = describeGraphQLFieldDiff(fieldChanges, beforeDef, afterDef);
        changes.push({
          name: afterDef.name,
          kind: mapGraphQLKind(afterDef.kind),
          changeType: "modified",
          details,
          fieldChanges,
        });
      }
    }
  }

  for (const [key, beforeDef] of beforeMap) {
    if (!afterMap.has(key)) {
      changes.push({
        name: beforeDef.name,
        kind: mapGraphQLKind(beforeDef.kind),
        changeType: "removed",
        details: `Removed ${beforeDef.kind} ${beforeDef.name}`,
      });
    }
  }

  return changes;
}

function summarizeGraphQLBody(body: string): string {
  const fields = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const names = fields.map((f) => f.split(/[:(]/)[0].trim()).filter(Boolean);
  return names.length > 0 ? names.join(", ") : "(empty)";
}

function describeGraphQLFieldDiff(
  fieldChanges: FieldChange[],
  _beforeDef: GraphQLDefinition,
  _afterDef: GraphQLDefinition
): string {
  const added = fieldChanges.filter((f) => f.changeType === "added");
  const removed = fieldChanges.filter((f) => f.changeType === "removed");
  const modified = fieldChanges.filter((f) => f.changeType === "modified");

  const parts: string[] = [];
  if (added.length > 0) {
    parts.push(`Added fields: ${added.map((f) => f.fieldName).join(", ")}`);
  }
  if (removed.length > 0) {
    parts.push(`Removed fields: ${removed.map((f) => f.fieldName).join(", ")}`);
  }
  if (modified.length > 0) {
    parts.push(`Modified fields: ${modified.map((f) => f.fieldName).join(", ")}`);
  }
  return parts.length > 0 ? parts.join("; ") : "Fields modified";
}

// ---- YAML/JSON config diffing (enhanced with array support) ----

/**
 * Flatten an object into key-value pairs for diffing.
 * Arrays are diffed element-by-element instead of being stringified whole.
 */
function flattenObject(
  obj: unknown,
  prefix = ""
): Map<string, string> {
  const map = new Map<string, string>();

  if (typeof obj !== "object" || obj === null) {
    map.set(prefix || "(root)", String(obj));
    return map;
  }

  if (Array.isArray(obj)) {
    // Element-by-element array flattening
    for (let i = 0; i < obj.length; i++) {
      const itemKey = prefix ? `${prefix}[${i}]` : `[${i}]`;
      const item = obj[i];

      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        // Recursively flatten object items
        for (const [fk, fv] of flattenObject(item, itemKey)) {
          map.set(fk, fv);
        }
      } else if (Array.isArray(item)) {
        // Recursively flatten nested arrays
        for (const [fk, fv] of flattenObject(item, itemKey)) {
          map.set(fk, fv);
        }
      } else {
        map.set(itemKey, String(item));
      }
    }
    // Also store array length so we can detect length changes
    map.set(prefix ? `${prefix}.__length` : "__length", String(obj.length));
    return map;
  }

  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "object" && v !== null) {
      for (const [fk, fv] of flattenObject(v, key)) {
        map.set(fk, fv);
      }
    } else {
      map.set(key, String(v ?? "null"));
    }
  }
  return map;
}

/**
 * Produce human-readable array diff for arrays of primitives.
 */
function diffArrayElements(
  beforeArr: unknown[],
  afterArr: unknown[]
): { added: string[]; removed: string[] } {
  const beforeSet = new Set(beforeArr.map(String));
  const afterSet = new Set(afterArr.map(String));
  const added = [...afterSet].filter((v) => !beforeSet.has(v));
  const removed = [...beforeSet].filter((v) => !afterSet.has(v));
  return { added, removed };
}

function parseYamlOrJson(content: string): unknown {
  try {
    if (content.trim().startsWith("{") || content.trim().startsWith("[")) {
      return JSON.parse(content);
    }
    return yaml.load(content);
  } catch {
    return null;
  }
}

function diffConfig(
  beforeContent: string | undefined,
  afterContent: string | undefined
): ConfigChange[] {
  const changes: ConfigChange[] = [];
  const beforeParsed = beforeContent ? parseYamlOrJson(beforeContent) : null;
  const afterParsed = afterContent ? parseYamlOrJson(afterContent) : null;

  const before = beforeParsed
    ? flattenObject(beforeParsed)
    : new Map<string, string>();
  const after = afterParsed
    ? flattenObject(afterParsed)
    : new Map<string, string>();

  // Filter out internal __length keys from reported changes
  const isLengthKey = (key: string) => key.endsWith(".__length") || key === "__length";

  for (const [key, afterVal] of after) {
    if (isLengthKey(key)) continue;
    if (!before.has(key)) {
      changes.push({ key, changeType: "added", newValue: afterVal });
    } else if (before.get(key) !== afterVal) {
      changes.push({
        key,
        changeType: "modified",
        oldValue: before.get(key),
        newValue: afterVal,
      });
    }
  }

  for (const [key, beforeVal] of before) {
    if (isLengthKey(key)) continue;
    if (!after.has(key)) {
      changes.push({ key, changeType: "removed", oldValue: beforeVal });
    }
  }

  return changes;
}

// ---- Main inspection ----

function fileMatchesRule(filename: string, rule: SyncRule): boolean {
  return minimatch(filename, rule.match.path_glob);
}

function fileMatchesType(
  filename: string,
  content: string | undefined,
  fileTypes: string[]
): string | null {
  const detected = detectFileType(filename);

  for (const ft of fileTypes) {
    switch (ft) {
      case "openapi":
      case "swagger":
        if (
          (detected === "yaml" || detected === "json") &&
          content &&
          isOpenAPIContent(content)
        ) {
          return "openapi";
        }
        break;
      case "graphql":
        if (detected === "graphql") return "graphql";
        break;
      case "yaml":
        if (detected === "yaml") return "yaml";
        break;
      case "json":
        if (detected === "json") return "json";
        break;
      case "config":
        if (detected === "yaml" || detected === "json") return "config";
        break;
    }
  }

  return null;
}

export function inspectChanges(
  changedFiles: FileChange[],
  rules: SyncRule[]
): ChangeSummary[] {
  const summaries: ChangeSummary[] = [];

  for (const rule of rules) {
    const summary: ChangeSummary = {
      rule,
      matchedFiles: [],
      endpoints: [],
      graphqlChanges: [],
      configChanges: [],
      rawPatches: [],
    };

    for (const file of changedFiles) {
      if (!fileMatchesRule(file.filename, rule)) continue;

      const contentForDetection = file.afterContent ?? file.beforeContent;
      const matchedType = fileMatchesType(
        file.filename,
        contentForDetection,
        rule.match.file_types
      );
      if (!matchedType) continue;

      summary.matchedFiles.push(file.filename);
      if (file.patch) {
        summary.rawPatches.push(`--- ${file.filename} ---\n${file.patch}`);
      }

      switch (matchedType) {
        case "openapi":
          summary.endpoints.push(
            ...diffOpenAPI(file.beforeContent, file.afterContent)
          );
          break;
        case "graphql":
          summary.graphqlChanges.push(
            ...diffGraphQL(file.beforeContent, file.afterContent)
          );
          break;
        case "yaml":
        case "json":
        case "config": {
          const fallbackContent = file.afterContent ?? file.beforeContent;
          if (fallbackContent && isOpenAPIContent(fallbackContent)) {
            summary.endpoints.push(
              ...diffOpenAPI(file.beforeContent, file.afterContent)
            );
          } else {
            summary.configChanges.push(
              ...diffConfig(file.beforeContent, file.afterContent)
            );
          }
          break;
        }
      }
    }

    if (summary.matchedFiles.length > 0) {
      summaries.push(summary);
    }
  }

  return summaries;
}

export function formatChangeSummary(summary: ChangeSummary): string {
  const lines: string[] = [];
  lines.push(`Files: ${summary.matchedFiles.join(", ")}`);

  if (summary.endpoints.length > 0) {
    lines.push("\nAPI Endpoint Changes:");
    for (const ep of summary.endpoints) {
      const icon =
        ep.changeType === "added"
          ? "+"
          : ep.changeType === "removed"
            ? "-"
            : "~";
      lines.push(`  ${icon} ${ep.method} ${ep.path}: ${ep.details}`);
    }
  }

  if (summary.graphqlChanges.length > 0) {
    lines.push("\nGraphQL Schema Changes:");
    for (const gc of summary.graphqlChanges) {
      const icon =
        gc.changeType === "added"
          ? "+"
          : gc.changeType === "removed"
            ? "-"
            : "~";
      lines.push(`  ${icon} ${gc.kind} ${gc.name}: ${gc.details}`);
      if (gc.fieldChanges && gc.fieldChanges.length > 0) {
        for (const fc of gc.fieldChanges) {
          const fieldIcon =
            fc.changeType === "added"
              ? "+"
              : fc.changeType === "removed"
                ? "-"
                : "~";
          lines.push(`    ${fieldIcon} ${fc.details}`);
        }
      }
    }
  }

  if (summary.configChanges.length > 0) {
    lines.push("\nConfig Changes:");
    for (const cc of summary.configChanges) {
      const icon =
        cc.changeType === "added"
          ? "+"
          : cc.changeType === "removed"
            ? "-"
            : "~";
      if (cc.changeType === "modified") {
        lines.push(
          `  ${icon} ${cc.key}: ${cc.oldValue} -> ${cc.newValue}`
        );
      } else if (cc.changeType === "added") {
        lines.push(`  ${icon} ${cc.key}: ${cc.newValue}`);
      } else {
        lines.push(`  ${icon} ${cc.key}: ${cc.oldValue}`);
      }
    }
  }

  return lines.join("\n");
}

// Export internal functions for testing
export {
  parseGraphQLDefinitions,
  diffGraphQL,
  diffConfig,
  flattenObject,
  diffArrayElements,
  diffOpenAPI,
  parseYamlOrJson,
  isOpenAPIContent,
  detectFileType,
  parseGraphQLFields,
  diffGraphQLFields,
};
