import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as crypto from "crypto";
import { verifyWebhookSignature } from "../src/webhook";

describe("verifyWebhookSignature", () => {
  const secret = "test-webhook-secret";

  function sign(payload: string, secretKey: string): string {
    return (
      "sha256=" +
      crypto.createHmac("sha256", secretKey).update(payload).digest("hex")
    );
  }

  it("accepts a valid signature", () => {
    const payload = '{"action":"opened"}';
    const signature = sign(payload, secret);
    expect(verifyWebhookSignature(payload, signature, secret)).toBe(true);
  });

  it("rejects an invalid signature", () => {
    const payload = '{"action":"opened"}';
    const badSignature = sign(payload, "wrong-secret");
    expect(verifyWebhookSignature(payload, badSignature, secret)).toBe(false);
  });

  it("rejects when no signature is provided", () => {
    expect(verifyWebhookSignature("payload", undefined, secret)).toBe(false);
  });

  it("rejects empty signature", () => {
    expect(verifyWebhookSignature("payload", "", secret)).toBe(false);
  });

  it("handles Buffer payload", () => {
    const payload = Buffer.from('{"action":"opened"}');
    const signature = sign(payload.toString("utf-8"), secret);
    expect(verifyWebhookSignature(payload, signature, secret)).toBe(true);
  });

  it("rejects when payload is tampered", () => {
    const original = '{"action":"opened"}';
    const signature = sign(original, secret);
    const tampered = '{"action":"closed"}';
    expect(verifyWebhookSignature(tampered, signature, secret)).toBe(false);
  });

  it("handles mismatched signature lengths gracefully", () => {
    // timingSafeEqual throws if lengths differ; our code catches that
    expect(verifyWebhookSignature("payload", "sha256=abc", secret)).toBe(false);
  });
});

describe("webhook module exports", () => {
  it("exports handleWebhook and verifyWebhookSignature", async () => {
    const mod = await import("../src/webhook");
    expect(typeof mod.handleWebhook).toBe("function");
    expect(typeof mod.verifyWebhookSignature).toBe("function");
    expect(typeof mod.processPR).toBe("function");
  });
});
