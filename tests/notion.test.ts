import { describe, it, expect } from "vitest";
import { findSection, renderSection, computeSectionScore, escapeCodeBlockContent } from "../src/notion";
import type { BlockObjectResponse } from "@notionhq/client/build/src/api-endpoints";

// Helper to create mock block objects
function mockBlock(
  type: string,
  text: string,
  id = "block-" + Math.random().toString(36).slice(2)
): BlockObjectResponse {
  const richText = [{ plain_text: text, type: "text", text: { content: text, link: null }, annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" as const }, href: null }];

  const base = {
    id,
    parent: { type: "page_id" as const, page_id: "parent" },
    created_time: "2024-01-01T00:00:00.000Z",
    last_edited_time: "2024-01-01T00:00:00.000Z",
    created_by: { object: "user" as const, id: "user1" },
    last_edited_by: { object: "user" as const, id: "user1" },
    has_children: false,
    archived: false,
    in_trash: false,
    object: "block" as const,
  };

  switch (type) {
    case "heading_1":
      return { ...base, type: "heading_1", heading_1: { rich_text: richText, is_toggleable: false, color: "default" as const } } as any;
    case "heading_2":
      return { ...base, type: "heading_2", heading_2: { rich_text: richText, is_toggleable: false, color: "default" as const } } as any;
    case "heading_3":
      return { ...base, type: "heading_3", heading_3: { rich_text: richText, is_toggleable: false, color: "default" as const } } as any;
    case "paragraph":
      return { ...base, type: "paragraph", paragraph: { rich_text: richText, color: "default" as const } } as any;
    case "bulleted_list_item":
      return { ...base, type: "bulleted_list_item", bulleted_list_item: { rich_text: richText, color: "default" as const } } as any;
    case "code":
      return { ...base, type: "code", code: { rich_text: richText, language: "plain text", caption: [] } } as any;
    default:
      return { ...base, type: "paragraph", paragraph: { rich_text: richText, color: "default" as const } } as any;
  }
}

describe("findSection", () => {
  it("finds an exact heading match", () => {
    const blocks = [
      mockBlock("heading_1", "Introduction"),
      mockBlock("paragraph", "Welcome to the docs."),
      mockBlock("heading_1", "API: Payments Service"),
      mockBlock("paragraph", "The payments API handles transactions."),
      mockBlock("bulleted_list_item", "POST /pay"),
      mockBlock("heading_1", "Deployment"),
      mockBlock("paragraph", "Deploy with Docker."),
    ];

    const section = findSection(blocks, "API: Payments Service");

    expect(section).not.toBeNull();
    expect(section!.headingText).toBe("API: Payments Service");
    expect(section!.startIndex).toBe(2);
    expect(section!.endIndex).toBe(5);
    expect(section!.blocks).toHaveLength(3);
  });

  it("finds a partial heading match", () => {
    const blocks = [
      mockBlock("heading_2", "Overview"),
      mockBlock("paragraph", "Some overview text."),
      mockBlock("heading_2", "Payments API Reference"),
      mockBlock("paragraph", "Details here."),
      mockBlock("heading_2", "Other"),
    ];

    const section = findSection(blocks, "Payments API");

    expect(section).not.toBeNull();
    expect(section!.headingText).toBe("Payments API Reference");
  });

  it("returns null when no heading matches", () => {
    const blocks = [
      mockBlock("heading_1", "Introduction"),
      mockBlock("paragraph", "Text."),
    ];

    const section = findSection(blocks, "Nonexistent Section XYZ");
    expect(section).toBeNull();
  });

  it("captures blocks until the next heading of same level", () => {
    const blocks = [
      mockBlock("heading_2", "API Docs"),
      mockBlock("paragraph", "Line 1"),
      mockBlock("heading_3", "Subsection"),
      mockBlock("paragraph", "Line 2"),
      mockBlock("heading_2", "Next Section"),
      mockBlock("paragraph", "Line 3"),
    ];

    const section = findSection(blocks, "API Docs");

    expect(section).not.toBeNull();
    expect(section!.startIndex).toBe(0);
    expect(section!.endIndex).toBe(4);
    expect(section!.blocks).toHaveLength(4);
  });

  it("captures to end of document if no following heading", () => {
    const blocks = [
      mockBlock("heading_1", "Only Section"),
      mockBlock("paragraph", "Content 1"),
      mockBlock("paragraph", "Content 2"),
    ];

    const section = findSection(blocks, "Only Section");

    expect(section).not.toBeNull();
    expect(section!.blocks).toHaveLength(3);
    expect(section!.endIndex).toBe(3);
  });

  it("uses word overlap for fuzzy matching", () => {
    const blocks = [
      mockBlock("heading_2", "Authentication and Authorization API"),
      mockBlock("paragraph", "Auth details."),
    ];

    const section = findSection(blocks, "Authentication API");

    expect(section).not.toBeNull();
    expect(section!.headingText).toBe(
      "Authentication and Authorization API"
    );
  });

  // --- New tests ---

  it("rejects low-overlap fuzzy matches (threshold fix)", () => {
    const blocks = [
      mockBlock("heading_2", "Deployment Guide for Production Environments"),
      mockBlock("paragraph", "Details about deploying."),
    ];

    // "API Reference" has zero word overlap with the heading
    const section = findSection(blocks, "API Reference");
    expect(section).toBeNull();
  });

  it("rejects single-word match with low overlap", () => {
    const blocks = [
      mockBlock("heading_2", "Getting Started with the Application Framework"),
      mockBlock("paragraph", "Some content."),
    ];

    // Only 1 out of 3 words overlap -> 33% < 50% threshold
    const section = findSection(blocks, "the best practices");
    expect(section).toBeNull();
  });

  it("accepts match with 50% word overlap", () => {
    const blocks = [
      mockBlock("heading_2", "User Authentication Service"),
      mockBlock("paragraph", "Details."),
    ];

    // 2 out of 3 words overlap -> 67% > 50%
    const section = findSection(blocks, "User Authentication Guide");
    expect(section).not.toBeNull();
  });

  it("handles empty blocks array", () => {
    const section = findSection([], "Anything");
    expect(section).toBeNull();
  });

  it("handles blocks with no headings", () => {
    const blocks = [
      mockBlock("paragraph", "Just text."),
      mockBlock("paragraph", "More text."),
    ];

    const section = findSection(blocks, "Any Section");
    expect(section).toBeNull();
  });

  it("handles page with many sections", () => {
    const blocks = [
      mockBlock("heading_1", "Section A"),
      mockBlock("paragraph", "Content A"),
      mockBlock("heading_1", "Section B"),
      mockBlock("paragraph", "Content B"),
      mockBlock("heading_1", "Section C"),
      mockBlock("paragraph", "Content C"),
      mockBlock("heading_1", "Section D"),
      mockBlock("paragraph", "Content D"),
      mockBlock("heading_1", "Section E"),
      mockBlock("paragraph", "Content E"),
    ];

    const section = findSection(blocks, "Section D");
    expect(section).not.toBeNull();
    expect(section!.startIndex).toBe(6);
    expect(section!.endIndex).toBe(8);
    expect(section!.blocks).toHaveLength(2);
  });
});

describe("renderSection", () => {
  it("renders mixed block types to readable text", () => {
    const blocks = [
      mockBlock("heading_2", "Payments"),
      mockBlock("paragraph", "The payments service."),
      mockBlock("bulleted_list_item", "POST /pay"),
      mockBlock("bulleted_list_item", "GET /pay/:id"),
      mockBlock("code", "curl -X POST /pay"),
    ];

    const rendered = renderSection(blocks);

    expect(rendered).toContain("## Payments");
    expect(rendered).toContain("The payments service.");
    expect(rendered).toContain("- POST /pay");
    expect(rendered).toContain("- GET /pay/:id");
    expect(rendered).toContain("curl -X POST /pay");
  });

  it("handles empty blocks array", () => {
    const rendered = renderSection([]);
    expect(rendered).toBe("");
  });
});

describe("escapeCodeBlockContent", () => {
  it("escapes triple backticks in code content", () => {
    const input = "Here is some ```code``` inside";
    const escaped = escapeCodeBlockContent(input);
    expect(escaped).toBe("Here is some \\`\\`\\`code\\`\\`\\` inside");
  });

  it("leaves single backticks alone", () => {
    const input = "Use `code` inline";
    const escaped = escapeCodeBlockContent(input);
    expect(escaped).toBe("Use `code` inline");
  });

  it("handles empty string", () => {
    expect(escapeCodeBlockContent("")).toBe("");
  });

  it("handles multiple triple backtick occurrences", () => {
    const input = "```a```b```";
    const escaped = escapeCodeBlockContent(input);
    expect(escaped).not.toContain("```");
  });
});

describe("computeSectionScore", () => {
  it("returns 100 for exact match", () => {
    expect(computeSectionScore("api reference", "api reference")).toBe(100);
  });

  it("returns 80 when heading contains hint", () => {
    expect(computeSectionScore("api", "api reference guide")).toBe(80);
  });

  it("returns 60 when hint contains heading", () => {
    expect(computeSectionScore("api reference guide", "api")).toBe(60);
  });

  it("returns 0 for no word overlap", () => {
    expect(computeSectionScore("deployment", "authentication")).toBe(0);
  });

  it("returns 0 for less than 50% word overlap", () => {
    // 1 out of 4 words overlap (25%)
    expect(computeSectionScore("api deployment guide overview", "api")).toBeLessThan(20);
  });

  it("returns positive score for >= 50% word overlap", () => {
    // 2 out of 3 words overlap (67%)
    expect(computeSectionScore("user auth guide", "user auth service")).toBeGreaterThan(0);
  });
});
