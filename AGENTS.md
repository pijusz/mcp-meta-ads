# Agent Guidelines for mcp-meta-ads

> Design decisions live in [docs/SPEC.md](docs/SPEC.md). This file documents conventions for working in the code.

## Project Structure

```
src/
├── index.ts                      # Entry point (stdio transport)
├── server.ts                     # McpServer creation + tool/resource registration
├── auth/
│   └── index.ts                  # Builds Authorization header from System User token
├── services/
│   ├── meta-graph-api.ts         # Central Graph client (graphFetch + rate-limit awareness + async insights)
│   ├── pii.ts                    # SHA256 + normalization rules per Meta spec
│   ├── targeting-builder.ts      # Builder helpers (interest/geo/behavior lookups → targeting spec)
│   ├── upload.ts                 # adimages + advideos upload (local file → hash/id + transcoding poll)
│   └── format.ts                 # JSON / TSV response formatters
├── tools/
│   ├── index.ts                  # Barrel: registers all tools on server
│   ├── accounts.ts               # (TBD)
│   ├── campaigns.ts              # campaign mutations
│   ├── adsets.ts                 # ad set mutations
│   ├── ads.ts                    # ad mutations
│   ├── creatives.ts              # creative create + asset upload
│   ├── audiences.ts              # custom audiences + lookalikes + PII upload
│   ├── insights.ts               # run_insights (sync→async auto)
│   ├── targeting.ts              # search_interests / search_geo_locations / build_targeting
│   ├── capi.ts                   # send_conversion_events
│   ├── catalogs.ts               # catalogs / DPA
│   └── engagement.ts             # comment read / page insights
├── resources/
│   ├── index.ts                  # Registers all `meta-ads://...` resources
│   ├── accounts.ts
│   ├── campaigns.ts
│   ├── adsets.ts
│   ├── ads.ts
│   ├── creatives.ts
│   ├── audiences.ts
│   └── insights.ts
├── config/
│   └── env.ts                    # Zod-validated env loading
├── types.ts                      # Shared types
└── utils/
    ├── account-id.ts             # normalizeActId() — "123" → "act_123"
    ├── logger.ts                 # stderr-only logger
    └── errors.ts                 # Translate Meta error subcodes → clear messages
```

## Authentication

Single method: System User access token in `META_ADS_ACCESS_TOKEN`. No OAuth flow. Auth header is built in `auth/index.ts` → `getAuthHeaders()`.

If `META_ADS_APP_SECRET` is set, all requests include an `appsecret_proof` query param (HMAC-SHA256 of token with the secret).

## Graph API conventions

### Path style

```ts
// Always include the version
const path = `${env.META_GRAPH_API_VERSION}/act_${accountId}/campaigns`;
graphFetch(path, { params: { fields: "id,name,status" } });
```

### Field selection

Meta returns minimal fields by default. **Always pass `?fields=...`** with exactly what you need.

### Pagination

Cursor-based. Reads return one page + `next_cursor`. Caller passes `cursor` on the next call. Don't auto-follow `paging.next` unless explicitly asked.

### Date ranges (insights)

Two forms:

```ts
// Preset
{ date_preset: "last_30d" }

// Explicit range
{ time_range: { since: "2026-04-01", until: "2026-04-30" } }
```

### Async insights

`run_insights` tool tries sync first. On `error_subcode === 1487504` (or estimated rows × cols > heuristic), it transparently:

1. `POST /act_X/insights` with same body → returns `{ report_run_id }`
2. Poll `GET /report_run_id?fields=async_status,async_percent_completion` until `async_status === "Job Completed"`
3. `GET /report_run_id/insights?fields=...` → paginate results

Timeout/poll cadence is configurable via `META_ADS_INSIGHTS_ASYNC_TIMEOUT_MS` / `META_ADS_INSIGHTS_ASYNC_POLL_MS`.

## Adding new tools

1. Create or edit a file in `src/tools/`
2. Export a `registerXTools(server: McpServer)` function
3. Use `server.tool(name, description, zodSchema, handler)` with **MCP annotations** (`destructiveHint`, `idempotentHint`, `readOnlyHint`)
4. Handler must return `{ content: [{ type: "text", text }] }`
5. Import and call registration in `src/tools/index.ts`
6. Mutation tool descriptions start with **⚠️ WRITE OPERATION**

## Adding new resources

1. Create or edit a file in `src/resources/`
2. Export a `registerXResources(server: McpServer)` function
3. Use `server.resource()` (or `server.registerResource()` for templates per SDK version)
4. Return `{ contents: [{ uri, mimeType, text }] }`
5. Tabular resources (insights) return TSV with `mimeType: "text/tab-separated-values"`
6. Single objects / nested lists return JSON with `mimeType: "application/json"`

## Output formatting

| Shape | Format | mimeType |
|---|---|---|
| Single object | Pretty JSON | `application/json` |
| List + cursor | `{ data, next_cursor? }` JSON | `application/json` |
| Insights tabular | TSV with header row | `text/tab-separated-values` |
| Targeting spec | JSON | `application/json` |
| Error | `{ error: {..., hint? } }` JSON | `application/json` |

## Mutation Tools

**No gate.** If `META_ADS_ACCESS_TOKEN` is set, all writable tools register. Posture: the operator is the admin; this matches GitHub/Linear MCP behavior. Re-evaluate if real users get burned.

All mutation tool descriptions start with **⚠️ WRITE OPERATION** so MCP clients (Claude Code, Cursor) render the permission prompt clearly.
