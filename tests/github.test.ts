import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeBotMarker } from "../src/github";

describe("makeBotMarker", () => {
  it("creates rule-specific markers", () => {
    const marker = makeBotMarker(0, "page-abc");
    expect(marker).toBe("<!-- specsync-bot:0:page-abc -->");
  });

  it("creates different markers for different rules", () => {
    const marker0 = makeBotMarker(0, "page-abc");
    const marker1 = makeBotMarker(1, "page-def");
    expect(marker0).not.toBe(marker1);
  });

  it("creates different markers for same rule index but different pages", () => {
    const markerA = makeBotMarker(0, "page-abc");
    const markerB = makeBotMarker(0, "page-def");
    expect(markerA).not.toBe(markerB);
  });

  it("includes both rule index and page ID", () => {
    const marker = makeBotMarker(5, "notion-page-12345");
    expect(marker).toContain("5");
    expect(marker).toContain("notion-page-12345");
    expect(marker).toContain("specsync-bot");
  });
});

describe("comment body construction", () => {
  it("marker format is an HTML comment that GitHub hides", () => {
    const marker = makeBotMarker(0, "test");
    expect(marker.startsWith("<!--")).toBe(true);
    expect(marker.endsWith("-->")).toBe(true);
  });
});

describe("GitHub module exports", () => {
  it("exports all necessary functions", async () => {
    const github = await import("../src/github");
    expect(typeof github.createOctokit).toBe("function");
    expect(typeof github.fetchPRChangedFiles).toBe("function");
    expect(typeof github.fetchFileContent).toBe("function");
    expect(typeof github.fetchPRDetails).toBe("function");
    expect(typeof github.enrichFileChangesWithContent).toBe("function");
    expect(typeof github.postOrUpdateComment).toBe("function");
    expect(typeof github.postErrorComment).toBe("function");
    expect(typeof github.fetchRepoFileContent).toBe("function");
    expect(typeof github.setGitHubRateLimiter).toBe("function");
  });
});
