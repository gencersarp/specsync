# SpecSync

A GitHub-native bot that detects when PRs change APIs or configs and auto-proposes updates to linked Notion spec pages, posting suggested diffs as PR comments.

## How It Works

1. A PR is opened or updated on your repo
2. SpecSync loads `.specsync.yml` from the repo root to find mapping rules
3. Changed files are matched against rules (by glob pattern and file type)
4. For matching files, SpecSync parses before/after content to extract structured changes:
   - **OpenAPI/Swagger**: new, removed, or modified endpoints, parameters, response schemas
   - **GraphQL SDL**: changed queries, mutations, types, inputs, enums
   - **YAML/JSON config**: changed keys and values
5. The linked Notion page is fetched and the relevant section is located
6. An LLM generates a suggested documentation update preserving existing style
7. A well-formatted PR comment is posted (or updated) with the proposed changes

## Setup

### 1. Create a GitHub App

1. Go to **Settings > Developer settings > GitHub Apps > New GitHub App**
2. Set the webhook URL to `https://your-server.com/webhook`
3. Generate a webhook secret and save it
4. Set permissions:
   - **Pull requests**: Read & write (for comments)
   - **Contents**: Read (for file access)
5. Subscribe to events: **Pull request**
6. Generate and download a private key
7. Install the app on your repository

### 2. Create a Notion Integration

1. Go to [Notion Integrations](https://www.notion.so/my-integrations)
2. Create a new internal integration
3. Copy the token
4. Share the target Notion pages with your integration

### 3. Configure Environment Variables

```bash
export GITHUB_APP_ID="your-app-id"
export GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n..."
export GITHUB_WEBHOOK_SECRET="your-webhook-secret"
export GITHUB_TOKEN="your-installation-token-or-pat"
export NOTION_TOKEN="your-notion-integration-token"
export LLM_API_KEY="your-openai-or-anthropic-key"
export LLM_API_URL="https://api.openai.com/v1/chat/completions"
export LLM_MODEL="gpt-4o"  # optional, defaults to gpt-4o
export PORT="3000"          # optional, defaults to 3000
```

The LLM client supports both OpenAI and Anthropic APIs. Set `LLM_API_URL` to:
- OpenAI: `https://api.openai.com/v1/chat/completions`
- Anthropic: `https://api.anthropic.com/v1/messages`

### 4. Add `.specsync.yml` to Your Repo

```yaml
rules:
  - match:
      path_glob: "services/payments/**"
      file_types: ["openapi", "graphql", "yaml"]
    doc:
      notion_page_id: "your-notion-page-id"
      section_hint: "API: Payments Service"
```

**Rule fields:**
- `match.path_glob`: Glob pattern for files to watch
- `match.file_types`: Array of `openapi`, `swagger`, `graphql`, `yaml`, `json`, `config`
- `doc.notion_page_id`: The Notion page ID to update
- `doc.section_hint`: Heading text to locate the relevant section

### 5. Run the Server

```bash
npm install
npm run build
npm start
```

For development:
```bash
npm run dev
```

## CLI Usage

Run SpecSync analysis on any PR without deploying the server:

```bash
# With environment variables set
npx specsync --repo owner/repo --pr 123

# With explicit flags
npx specsync --repo owner/repo --pr 123 \
  --github-token ghp_... \
  --notion-token ntn_... \
  --llm-api-key sk-... \
  --llm-api-url https://api.openai.com/v1/chat/completions

# Dry run (skip Notion/LLM, just show detected changes)
npx specsync --repo owner/repo --pr 123 --dry-run
```

## Testing

```bash
npm test
```

## Project Structure

```
specsync/
  src/
    config.ts          - .specsync.yml parser and validator
    diff-inspector.ts  - PR diff analysis (OpenAPI, GraphQL, config)
    notion.ts          - Notion page fetching and section finding
    llm.ts             - LLM-powered doc diff generation
    github.ts          - GitHub API interactions and comment posting
    webhook.ts         - Webhook handler and orchestration
    index.ts           - Express server entry point
    cli.ts             - CLI tool for local analysis
  tests/
    config.test.ts
    diff-inspector.test.ts
    notion.test.ts
    llm.test.ts
  examples/
    .specsync.yml      - Example configuration
```
