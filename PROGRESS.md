# SpecSync Progress

## Production-Readiness Overhaul

This document tracks all fixes and improvements made to bring SpecSync from MVP to a publishable, production-quality GitHub App.

---

### Critical Bug Fixes

1. **Comment collision bug (src/github.ts)**: The bot marker was a single global `<!-- specsync-bot -->`, meaning multiple rules would overwrite each other's comments. Fixed by making markers rule-specific: `<!-- specsync-bot:RULE_INDEX:NOTION_PAGE_ID -->`. Each rule now gets its own independently-updated PR comment.

2. **Webhook signature verification (src/index.ts)**: The raw body handling was broken -- `express.json()` with a `verify` callback was unreliable. Replaced with `express.raw({ type: "application/json" })` on the webhook route specifically, then manual JSON parsing after signature verification.

3. **GraphQL parsing gaps (src/diff-inspector.ts)**: The regex parser missed Query/Mutation root definitions, directives, interface definitions, extend type blocks, and schema blocks. Added balanced-brace extraction for all definition types. Also added field-level granular diffing (not just "type changed" but "field X added to type Y").

4. **Array diffing (src/diff-inspector.ts)**: Config diffing previously stringified entire arrays as single values. Now arrays are flattened element-by-element (`key[0]`, `key[1]`, etc.) and arrays of objects are compared by index with recursive flattening.

5. **Fuzzy matching threshold (src/notion.ts)**: Score threshold raised from 10 to 20, and word-overlap scoring now requires at least 50% of hint words to be present. Exact substring matching remains highest priority. Extracted `computeSectionScore()` as a testable function.

6. **Code block rendering (src/notion.ts)**: Backticks inside code block content are now escaped (`\`\`\`` -> `\\\`\\\`\\\``) to prevent malformed markdown in PR comments.

7. **Anthropic API version (src/llm.ts)**: Updated from `"2023-06-01"` to `"2025-01-01"`. Made configurable via `ANTHROPIC_API_VERSION` env var or `anthropicApiVersion` in LLMConfig.

8. **LLM retry logic (src/llm.ts)**: Added exponential backoff (1s, 2s, 4s, capped at 10s) for transient failures (429, 5xx). Configurable timeout (default 30s) via AbortController. Configurable max retries (default 3). Network errors and timeouts also trigger retries.

9. **Error reporting to PR (src/webhook.ts)**: When Notion API or LLM fails, the error is now posted as a PR comment (via `postErrorComment()`) instead of only logging to console.

10. **Multi-rule handling (src/webhook.ts)**: Each rule is processed independently via `processRule()`. Each gets its own PR comment (per-rule markers). Errors in one rule do not block others. All errors are collected and reported.

### New Modules

11. **TypeScript interfaces (src/types.ts)**: Comprehensive type definitions for NotionBlock, NotionPage, GitHubPR, PRFile, ChangeItem, DocDiff, SpecSyncConfig, rate limiter options, webhook payloads, and LLM responses. Eliminates `as any` casts in notion.ts and llm.ts.

12. **Rate limiter (src/rate-limiter.ts)**: Token bucket implementation with configurable max tokens and refill rate. Pre-configured limiters for GitHub (80 tokens, 1.3/s) and Notion (3 tokens, 2.5/s). `withRateLimit()` wrapper function. Integrated into github.ts and notion.ts.

### Test Coverage

13. **Expanded tests**:
    - `tests/config.test.ts`: Added invalid YAML syntax, non-YAML input, string-instead-of-array rules, empty arrays, non-string file types, null values, multiple rules, glob patterns with special characters.
    - `tests/diff-inspector.test.ts`: Added complex OpenAPI with nested schemas, GraphQL Query/Mutation root operations, interface definitions, directive definitions, extend type, schema blocks, field-level diff, array element-by-element diffing, arrays of objects, empty files, binary files.
    - `tests/github.test.ts`: New file. Tests rule-specific marker generation, marker uniqueness, HTML comment format, module exports.
    - `tests/webhook.test.ts`: New file. Tests signature verification (valid, invalid, missing, tampered, Buffer payload, length mismatch), module exports.
    - `tests/notion.test.ts`: Added fuzzy matching threshold enforcement, low-overlap rejection, 50% overlap acceptance, empty blocks, no-headings pages, large pages, code block escaping, `computeSectionScore()` unit tests.
    - `tests/llm.test.ts`: Added timeout handling, retry logic (transient errors, exhausted retries, non-retryable 401), configurable Anthropic version, empty/whitespace responses, partial JSON, `isTransientError()` and `backoffDelay()` unit tests.
    - `tests/rate-limiter.test.ts`: New file. Token acquisition, exhaustion, refill over time, max cap, withRateLimit wrapper, pre-configured limiters.

### Infrastructure & Configuration

14. **.gitignore**: node_modules, dist, .env, logs, coverage, .DS_Store, .pem files.

15. **.env.example**: All environment variables documented with descriptions.

16. **Dockerfile**: Multi-stage build (builder + production). Non-root user. Health check. Node.js 20 Alpine.

17. **docker-compose.yml**: Single service with env_file mounting, health check, restart policy.

18. **package.json**: Added `test:coverage`, `lint`, `clean` scripts. All dependencies present.

19. **tsconfig.json**: Strict mode enabled, `noUncheckedIndexedAccess` added.

20. **README.md**: Complete rewrite with architecture diagram, step-by-step GitHub App creation guide, Notion API setup, deployment options (Docker, Railway, Vercel), environment variable reference, troubleshooting, contributing guidelines.

21. **PROGRESS.md**: This file.

---

### Files Modified
- `src/index.ts` - Webhook raw body handling fix
- `src/github.ts` - Per-rule comment markers, rate limiting, error comment posting
- `src/notion.ts` - Fuzzy matching threshold, code block escaping, rate limiting, typed blocks
- `src/llm.ts` - Anthropic API version, retry logic, timeout, configurable options
- `src/webhook.ts` - Multi-rule orchestration, error reporting to PR
- `src/diff-inspector.ts` - GraphQL full parser, array element diffing, field-level diffs
- `package.json` - Scripts, dependencies
- `tsconfig.json` - Strict options
- `README.md` - Complete rewrite

### Files Created
- `src/types.ts` - Shared TypeScript interfaces
- `src/rate-limiter.ts` - Token bucket rate limiter
- `tests/github.test.ts` - GitHub module tests
- `tests/webhook.test.ts` - Webhook handler tests
- `tests/rate-limiter.test.ts` - Rate limiter tests
- `.gitignore`
- `.env.example`
- `Dockerfile`
- `docker-compose.yml`
- `PROGRESS.md`
