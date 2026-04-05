import express from "express";
import { handleWebhook, WebhookEnv } from "./webhook";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

function loadEnv(): WebhookEnv {
  return {
    githubAppId: requireEnv("GITHUB_APP_ID"),
    githubPrivateKey: requireEnv("GITHUB_PRIVATE_KEY"),
    githubWebhookSecret: requireEnv("GITHUB_WEBHOOK_SECRET"),
    githubToken: requireEnv("GITHUB_TOKEN"),
    notionToken: requireEnv("NOTION_TOKEN"),
    llmApiKey: requireEnv("LLM_API_KEY"),
    llmApiUrl: requireEnv("LLM_API_URL"),
    llmModel: process.env["LLM_MODEL"],
  };
}

/**
 * Express request extended with rawBody for webhook signature verification.
 */
interface RawBodyRequest extends express.Request {
  rawBody?: Buffer;
}

function main(): void {
  const env = loadEnv();
  const app = express();
  const port = parseInt(process.env["PORT"] ?? "3000", 10);

  // For the webhook route, use raw body parsing so we can verify the signature
  // against the exact bytes GitHub sent, then parse JSON ourselves.
  app.post(
    "/webhook",
    express.raw({ type: "application/json" }),
    (req: RawBodyRequest, res) => {
      // req.body is a Buffer when using express.raw()
      const rawBuffer: Buffer = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(String(req.body), "utf-8");

      // Store raw body for signature verification
      req.rawBody = rawBuffer;

      // Parse JSON from the raw buffer
      try {
        req.body = JSON.parse(rawBuffer.toString("utf-8"));
      } catch {
        res.status(400).json({ error: "Invalid JSON payload" });
        return;
      }

      handleWebhook(req, res, env);
    }
  );

  // JSON parsing for non-webhook routes
  app.use(express.json());

  // Health check
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "specsync",
      timestamp: new Date().toISOString(),
    });
  });

  app.listen(port, () => {
    console.log(`SpecSync server running on port ${port}`);
    console.log(`  Webhook endpoint: POST /webhook`);
    console.log(`  Health check:     GET  /health`);
  });
}

main();
