# mcp-meta-ads

Meta (Facebook) Ads MCP server in Bun/TypeScript. See [AGENTS.md](AGENTS.md) for detailed guidelines and [docs/SPEC.md](docs/SPEC.md) for design decisions.

## Quick reference

- **Runtime:** Bun (dev) / Node (built)
- **Entry:** `src/index.ts`
- **Build:** `bun run build` → `mcp-meta-ads` (standalone binary), `bun run build:npm` → `dist/index.js`
- **Test:** `bun test`
- **API version:** v23.0 (Meta Graph API / Marketing API)

## Key patterns

- All tools return `{ content: [{ type: "text", text }] }` — MCP tool response format
- Reads are MCP **resources** (`meta-ads://act_<id>/...`); mutations are **tools**
- `graphFetch` in `services/meta-graph-api.ts` handles 429/5xx with exponential backoff + reads `X-Business-Use-Case-Usage` / `X-App-Usage` headers
- Auth: System User token in `META_ADS_ACCESS_TOKEN` (no OAuth flow)
- Insights: auto-async fallback (sync → async job + poll → results)
- PII for custom audiences is hashed server-side per Meta's normalization spec (`services/pii.ts`)
- **No mutation gate** — all writable surfaces ship live; trust the operator

## Prod testing (published package)

Use the published package for production validation:

```bash
claude mcp add meta-ads --scope user --transport stdio \
  -e META_ADS_ACCESS_TOKEN=... \
  -- npx -y mcp-meta-ads@latest
```

If you see `handshaking ... connection closed: initialize response`, the process is exiting before MCP init. Check these first:

1. `npx -y mcp-meta-ads@latest --version` works (npm registry reachable).
2. `META_ADS_ACCESS_TOKEN` is set in MCP env.
3. The token is a valid System User access token (test with `curl 'https://graph.facebook.com/v23.0/me?access_token=$TOKEN'`).
