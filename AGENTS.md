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

## Tests

Three tiers:

| Tier | Path | Run with | When |
|---|---|---|---|
| Unit | `tests/*.test.ts` | `bun test` | Always — runs in CI without credentials |
| Live integration | `tests/live/*.test.ts` | `bun run test:live` | Local opt-in only — hits real Meta API |
| Fallback cleanup | `scripts/cleanup-test-entities.ts` | `bun run test:cleanup` | When a live test crashed and left orphans |

### Running live tests

Live tests are gated by three env vars (all required):

- `META_ADS_RUN_LIVE_TESTS=true` — explicit opt-in (the `test:live` script sets this)
- `META_ADS_ACCESS_TOKEN` — your System User token (read from `.env`)
- `META_ADS_TEST_ACCOUNT_ID` — the ad account these tests are allowed to mutate. **Never falls back to the first account on `/me/adaccounts` — always require explicit opt-in to avoid accidental writes to production.**

```bash
# In .env or shell env:
META_ADS_TEST_ACCOUNT_ID=act_1234567890

bun run test:live
```

If any of the three vars are missing, every live test skips with a reason in the describe label (e.g. `[live] campaigns (META_ADS_TEST_ACCOUNT_ID not set)`).

### Cleanup invariant

Live tests follow a strict create-then-delete contract:

- Every created entity is registered via `registry.trackCampaign(id)` (etc.).
- `afterEach` runs `registry.cleanup()` — deletes everything tracked, in dependency order (ads → adsets → campaigns → creatives → audiences).
- 404s during cleanup are swallowed (object was already deleted by the test itself).
- Every entity name is prefixed `mcp-meta-ads-test-` so the fallback `bun run test:cleanup` script can find orphans if a test crashed.

```bash
# Dry-run: show what would be deleted without doing it
bun run test:cleanup:dry

# Nuke any leftover mcp-meta-ads-test-* entities in the test account
bun run test:cleanup
```

### Adding a new live test

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { createRegistry, getTestAccountId, liveSkipReason, liveTestsEnabled, testName } from "./_helpers";

const registry = createRegistry();
afterEach(() => registry.cleanup());

describe.skipIf(!liveTestsEnabled())(
  `[live] my feature (${liveSkipReason()})`,
  () => {
    test("does the thing", async () => {
      const actId = getTestAccountId();
      const name = testName("myfeature");
      // ... create entity, track it, assert, etc.
    });
  },
);
```
