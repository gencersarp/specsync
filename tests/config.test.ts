import { describe, it, expect } from "vitest";
import { parseConfigFromString } from "../src/config";

describe("parseConfigFromString", () => {
  it("parses a valid config with one rule", () => {
    const yaml = `
rules:
  - match:
      path_glob: "services/payments/**"
      file_types: ["openapi", "graphql"]
    doc:
      notion_page_id: "abc123"
      section_hint: "Payments API"
`;
    const config = parseConfigFromString(yaml);
    expect(config.rules).toHaveLength(1);
    expect(config.rules[0].match.path_glob).toBe("services/payments/**");
    expect(config.rules[0].match.file_types).toEqual(["openapi", "graphql"]);
    expect(config.rules[0].doc.notion_page_id).toBe("abc123");
    expect(config.rules[0].doc.section_hint).toBe("Payments API");
  });

  it("parses a config with multiple rules", () => {
    const yaml = `
rules:
  - match:
      path_glob: "api/**"
      file_types: ["openapi"]
    doc:
      notion_page_id: "page1"
      section_hint: "API Docs"
  - match:
      path_glob: "config/**"
      file_types: ["yaml", "json"]
    doc:
      notion_page_id: "page2"
      section_hint: "Config Section"
`;
    const config = parseConfigFromString(yaml);
    expect(config.rules).toHaveLength(2);
    expect(config.rules[0].match.path_glob).toBe("api/**");
    expect(config.rules[1].match.file_types).toEqual(["yaml", "json"]);
  });

  it("throws on missing rules key", () => {
    const yaml = `
something_else:
  - foo: bar
`;
    expect(() => parseConfigFromString(yaml)).toThrow(
      "must have a 'rules' array"
    );
  });

  it("throws on empty rules array", () => {
    const yaml = `
rules: []
`;
    expect(() => parseConfigFromString(yaml)).toThrow(
      "must have at least one rule"
    );
  });

  it("throws on missing match object", () => {
    const yaml = `
rules:
  - doc:
      notion_page_id: "abc"
      section_hint: "Test"
`;
    expect(() => parseConfigFromString(yaml)).toThrow(
      "must have a 'match' object"
    );
  });

  it("throws on missing doc object", () => {
    const yaml = `
rules:
  - match:
      path_glob: "**"
      file_types: ["yaml"]
`;
    expect(() => parseConfigFromString(yaml)).toThrow(
      "must have a 'doc' object"
    );
  });

  it("throws on invalid file_type", () => {
    const yaml = `
rules:
  - match:
      path_glob: "**"
      file_types: ["python"]
    doc:
      notion_page_id: "abc"
      section_hint: "Test"
`;
    expect(() => parseConfigFromString(yaml)).toThrow(
      "unknown file_type 'python'"
    );
  });

  it("throws on empty path_glob", () => {
    const yaml = `
rules:
  - match:
      path_glob: ""
      file_types: ["yaml"]
    doc:
      notion_page_id: "abc"
      section_hint: "Test"
`;
    expect(() => parseConfigFromString(yaml)).toThrow(
      "path_glob must be a non-empty string"
    );
  });

  it("throws on empty notion_page_id", () => {
    const yaml = `
rules:
  - match:
      path_glob: "**"
      file_types: ["yaml"]
    doc:
      notion_page_id: ""
      section_hint: "Test"
`;
    expect(() => parseConfigFromString(yaml)).toThrow(
      "notion_page_id must be a non-empty string"
    );
  });

  it("throws on non-YAML input", () => {
    expect(() => parseConfigFromString("")).toThrow();
  });

  it("accepts all valid file types", () => {
    const yaml = `
rules:
  - match:
      path_glob: "**"
      file_types: ["openapi", "graphql", "yaml", "json", "config", "swagger"]
    doc:
      notion_page_id: "abc"
      section_hint: "All types"
`;
    const config = parseConfigFromString(yaml);
    expect(config.rules[0].match.file_types).toHaveLength(6);
  });

  // --- New tests ---

  it("throws on invalid YAML syntax", () => {
    const badYaml = `
rules:
  - match:
    path_glob: "**"
    file_types: [
`;
    expect(() => parseConfigFromString(badYaml)).toThrow();
  });

  it("throws when rules is a string instead of array", () => {
    const yaml = `rules: "not-an-array"`;
    expect(() => parseConfigFromString(yaml)).toThrow("must have a 'rules' array");
  });

  it("throws when rule is a string instead of object", () => {
    const yaml = `
rules:
  - "just a string"
`;
    expect(() => parseConfigFromString(yaml)).toThrow("must be an object");
  });

  it("throws on empty file_types array", () => {
    const yaml = `
rules:
  - match:
      path_glob: "**"
      file_types: []
    doc:
      notion_page_id: "abc"
      section_hint: "Test"
`;
    expect(() => parseConfigFromString(yaml)).toThrow(
      "file_types must be a non-empty array"
    );
  });

  it("throws on non-string file_type", () => {
    const yaml = `
rules:
  - match:
      path_glob: "**"
      file_types: [123]
    doc:
      notion_page_id: "abc"
      section_hint: "Test"
`;
    expect(() => parseConfigFromString(yaml)).toThrow(
      "each file_type must be a string"
    );
  });

  it("throws on empty section_hint", () => {
    const yaml = `
rules:
  - match:
      path_glob: "**"
      file_types: ["yaml"]
    doc:
      notion_page_id: "abc"
      section_hint: ""
`;
    expect(() => parseConfigFromString(yaml)).toThrow(
      "section_hint must be a non-empty string"
    );
  });

  it("parses config with three rules correctly", () => {
    const yaml = `
rules:
  - match:
      path_glob: "services/payments/**"
      file_types: ["openapi", "graphql", "yaml"]
    doc:
      notion_page_id: "page1"
      section_hint: "Payments"
  - match:
      path_glob: "services/auth/**"
      file_types: ["openapi", "json"]
    doc:
      notion_page_id: "page2"
      section_hint: "Auth"
  - match:
      path_glob: "config/**"
      file_types: ["yaml", "json", "config"]
    doc:
      notion_page_id: "page3"
      section_hint: "Configuration"
`;
    const config = parseConfigFromString(yaml);
    expect(config.rules).toHaveLength(3);
    expect(config.rules[2].doc.section_hint).toBe("Configuration");
  });

  it("handles glob patterns with special characters", () => {
    const yaml = `
rules:
  - match:
      path_glob: "src/**/*.{yaml,yml}"
      file_types: ["yaml"]
    doc:
      notion_page_id: "abc"
      section_hint: "Test"
`;
    const config = parseConfigFromString(yaml);
    expect(config.rules[0].match.path_glob).toBe("src/**/*.{yaml,yml}");
  });

  it("handles simple wildcard glob patterns", () => {
    const yaml = `
rules:
  - match:
      path_glob: "*.json"
      file_types: ["json"]
    doc:
      notion_page_id: "abc"
      section_hint: "Root configs"
`;
    const config = parseConfigFromString(yaml);
    expect(config.rules[0].match.path_glob).toBe("*.json");
  });

  it("throws on null YAML content", () => {
    expect(() => parseConfigFromString("null")).toThrow();
  });

  it("throws on numeric YAML content", () => {
    expect(() => parseConfigFromString("42")).toThrow();
  });

  it("validates notion_page_id is a string not null", () => {
    const yaml = `
rules:
  - match:
      path_glob: "**"
      file_types: ["yaml"]
    doc:
      notion_page_id: null
      section_hint: "Test"
`;
    expect(() => parseConfigFromString(yaml)).toThrow("notion_page_id");
  });
});
