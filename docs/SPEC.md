# mcp-meta-ads — Spec

> Meta (Facebook) Ads MCP server. Bun/TypeScript. Mirrors the structure of [`mcp-gads`](https://github.com/pijusz/mcp-gads) for Google Ads.

**Status:** Draft v0 — spec derived from interview on 2026-05-11.
**Sibling project:** `../mcp-gads` (Google Ads MCP).
**npm name:** `mcp-meta-ads`.
**License:** MIT.

---

## 1. Goal

A Model Context Protocol server that exposes Meta's Marketing API (Graph API v25.0) to AI clients so that an LLM agent can:

- **Read** the full ads hierarchy + insights (account → campaign → ad set → ad → creative → audience).
- **Mutate** every writable surface: create, update, pause/resume, archive, delete.
- **Run analytics** with the full insights matrix (breakdowns, attribution windows, action breakdowns, custom conversions).
- **Manage creatives end-to-end**: upload images/videos from local paths, build creatives, build ads.
- **Manage audiences**: custom audiences from customer files (with safe server-side PII hashing), lookalikes.
- **Send Conversions API events** (CAPI read + write).
- **Browse catalogs, pixel events, page engagement** (Tier 4 scope).

Target user: agencies, in-house marketing engineers, power users with a Business Manager System User token.

---

## 2. Decisions (interview record)

Each row below was an explicit choice during the planning interview. **Rationale + tradeoffs are recorded so future-me can revisit.**

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | **Auth** | System User token from env (`META_ADS_ACCESS_TOKEN`). | No OAuth flow, no reviewed Meta app needed. Target user already has BM admin rights. Simplest path to v0.1. |
| 2 | **Mutation safety** | **No gate** — if the token is wired up, all mutations ship writable. | Operator is presumed to be the admin. Matches the posture of GitHub/Linear MCPs. Trades safety for ergonomic agentic workflows. |
| 3 | **API scope** | **Tier 4 — everything** (campaign hierarchy + insights + creatives + audiences + pixel/CAPI + catalogs + page engagement read). | User wants a full Meta ads surface, not a thin slice. Will be released in phases (see §10). |
| 4 | **Tool shape** | **Resource-first** for reads, **tools** for mutations. Markdown docs explain how to switch surface if the client doesn't support resources well. | Cleanest MCP design. Mutations stay imperative. Tradeoff: resources support is uneven across MCP clients — documented escape hatches mitigate. |
| 5 | **Resource URI scheme** | `meta-ads://act_<id>/<resource>[/<id>][?query]` — account always explicit. | No hidden default-account state. Forces the agent to list accounts before acting. |
| 6 | **Insights depth** | Full surface + **auto-async fallback**. Sync by default; transparently flips to async job + polling when Meta requires it. | One-call ergonomics; LLM never has to think about async unless polling exceeds a configurable timeout. |
| 7 | **Asset upload** | **Local file paths only** in v0.1 (`image_path: "/abs/path.jpg"`). URL/base64 deferred. | Matches stdio MCP deployment (server runs on user's machine). Avoids context bloat from base64. |
| 8 | **Rate-limit posture** | **Header-aware adaptive backoff** — parse `X-Business-Use-Case-Usage` + `X-App-Usage` on every response, proactively slow at >75%, exponential backoff on 429/throttle subcodes. | Meta throttling is brutal and per-account; reactive-only retries leave agents stuck. |
| 9 | **PII hashing for audiences** | **Server hashes raw PII** (lowercases/trims/normalizes per Meta spec, then SHA256). | Removes the #1 footgun (hash-of-raw-email producing zero matches). Stdio MCP runs locally, so PII never leaves the user's machine. |
| 10 | **API version pinning** | **Pin to `v25.0`** in code (initially planned v23.0 — bumped 2026-05-11 when v25.0 was found to be current stable); bump in a minor release after testing. Override available via `META_GRAPH_API_VERSION` env. | Predictable; mirrors mcp-gads's pin-and-bump posture. |
| 11 | **Conversions API scope** | **Full CAPI — read + write events.** | Consistent with the no-gate philosophy. Includes test_events and live events. Documented warning that bad event_id usage corrupts attribution. |
| 12 | **Targeting spec helpers** | **Builder-style helpers** — `build_targeting({ countries: ['US'], age: [25, 54], interests: ['fitness'] })` internally does lookups + assembles Meta's nested spec. Plus the raw spec is always accepted as an escape hatch. | Highest LLM ergonomics; LLM works with human concepts, not FB-internal interest IDs. |
| 13 | **Pagination** | **One page at a time with cursors.** Each resource read returns one page + `next_cursor`. | Honest about the underlying model. LLM must explicitly request more. Token-conscious. |
| 14 | **Output format** | **Compact text format (CSV/TSV) for tabular data**, JSON-as-text for nested objects. Selection rule below in §6.5. | Token-efficient for the heaviest read path (insights). |
| 15 | **Repo layout** | **Mirror mcp-gads exactly.** Same scripts, same dir structure, same release flow (CPTRP), same MIT, same npm-name pattern. | Zero novel scaffolding decisions; muscle memory from gads transfers. |

---

## 3. Architecture

### 3.1 Stack

- **Runtime (dev):** Bun
- **Runtime (built):** Node ≥ 18 (npm dist) + standalone Bun-compiled binary (GitHub Releases)
- **Language:** TypeScript
- **MCP SDK:** `@modelcontextprotocol/sdk` (same version pin as mcp-gads)
- **Schema validation:** `zod`
- **Lint/format:** `@biomejs/biome`
- **Tests:** `bun test`

### 3.2 File layout (mirrors `mcp-gads`)

```
src/
├── index.ts                      # Entry: stdio transport + setup dispatch
├── server.ts                     # McpServer creation; registers tools + resources
├── auth/
│   ├── index.ts                  # Builds Authorization header from System User token
│   └── validate.ts               # Optional /me probe at startup to fail fast
├── services/
│   ├── meta-graph-api.ts         # Central Graph client (fetchWithRetry + rate-limit awareness + auto-async insights)
│   ├── pagination.ts             # Cursor passthrough + page-size helpers
│   ├── pii.ts                    # SHA256 + normalization rules per Meta spec
│   ├── targeting-builder.ts      # Builder helpers (interest/geo/behavior lookups + spec assembly)
│   ├── upload.ts                 # adimages + advideos upload (local file → hash/id + transcoding poll)
│   └── format.ts                 # JSON / CSV / TSV response formatters
├── tools/
│   ├── index.ts                  # Barrel: registers all tools on server
│   ├── accounts.ts               # list_accounts, get_account, get_business_assets
│   ├── campaigns.ts              # create/update/pause/resume/archive/delete + duplicate
│   ├── adsets.ts                 # create/update/pause/resume/archive/delete + targeting helpers
│   ├── ads.ts                    # create/update/pause/resume/archive/delete
│   ├── creatives.ts              # create_creative + upload_image + upload_video
│   ├── audiences.ts              # custom audiences CRUD + lookalikes + customer file upload (hashed)
│   ├── insights.ts               # run_insights (sync→async auto), build_insights_query helper
│   ├── targeting.ts              # search_interests/geo/behaviors + build_targeting
│   ├── capi.ts                   # send_conversion_events (test + live) + read pixel events
│   ├── catalogs.ts               # catalogs / product sets / DPA
│   └── engagement.ts             # comment read + page insights
├── resources/
│   ├── index.ts                  # Registers all `meta-ads://...` resources
│   ├── accounts.ts               # meta-ads://accounts, meta-ads://act_X
│   ├── campaigns.ts              # meta-ads://act_X/campaigns[/id]
│   ├── adsets.ts                 # meta-ads://act_X/adsets[/id]
│   ├── ads.ts                    # meta-ads://act_X/ads[/id]
│   ├── creatives.ts              # meta-ads://act_X/creatives[/id]
│   ├── audiences.ts              # meta-ads://act_X/audiences[/id]
│   └── insights.ts               # meta-ads://act_X/insights?level=...&breakdowns=...&date_preset=...
├── config/
│   └── env.ts                    # Zod-validated env loading
├── types.ts                      # Shared types (CampaignObjective, BillingEvent, etc.)
└── utils/
    ├── account-id.ts             # normalizeActId() — accepts "123" or "act_123"
    ├── logger.ts                 # stderr-only logger (stdio MCP must keep stdout clean)
    └── errors.ts                 # Translate Meta error subcodes → clear messages
```

### 3.3 Entry & dispatch

`src/index.ts` (mirroring gads pattern):
- Reads env via `config/env.ts`.
- If `process.argv[2] === "setup"` → run a help printer (since there's no OAuth, "setup" just validates the token + prints diagnostics).
- Otherwise → stdio transport + `createServer()` from `server.ts`.

---

## 4. Authentication

### 4.1 Required env

| Var | Required | Notes |
|---|---|---|
| `META_ADS_ACCESS_TOKEN` | ✓ | System User token from Business Manager. Long-lived (effectively non-expiring unless revoked). |
| `META_ADS_APP_SECRET` | optional | If present, all requests include `appsecret_proof` for additional security (HMAC-SHA256 of the token with the app secret). |
| `META_GRAPH_API_VERSION` | optional | Defaults to `v25.0`. Documented but not encouraged to override. |
| `META_ADS_RATE_LIMIT_THRESHOLD` | optional | Default `75` — when any usage counter exceeds this %, server inserts proactive backoff. |
| `META_ADS_DEFAULT_PAGE_SIZE` | optional | Default `25` (Meta's own default). |
| `META_ADS_INSIGHTS_ASYNC_TIMEOUT_MS` | optional | Default `120000` (2 min) — abort polling after this. |
| `META_ADS_INSIGHTS_ASYNC_POLL_MS` | optional | Default `2000` — base poll interval; exponential up to `15000`. |
| `META_ADS_LOG_LEVEL` | optional | `error` \| `warn` \| `info` \| `debug` — default `warn`. Stderr only. |

### 4.2 Header assembly

```ts
// src/auth/index.ts
export function getAuthHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${env.META_ADS_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  };
}
```

If `META_ADS_APP_SECRET` is set, append `appsecret_proof` as a query param on every request (HMAC-SHA256 of the token using the secret as key, hex-encoded).

### 4.3 Startup probe (optional, off by default)

`META_ADS_VALIDATE_AT_STARTUP=true` → call `GET /me?fields=id,name` once before opening the transport. Fail fast with a clear error if the token is invalid/expired/revoked. Off by default to keep startup time tight.

---

## 5. Resource URI scheme

> Every read path is a resource. Every mutation is a tool. The MCP client renders resources as browsable; tools as permission-gated actions.

### 5.1 URI grammar

```
meta-ads://accounts                                  # list ad accounts user has access to
meta-ads://act_<id>                                  # account details
meta-ads://act_<id>/campaigns                        # list campaigns (paginated)
meta-ads://act_<id>/campaigns/<campaign_id>          # one campaign
meta-ads://act_<id>/adsets                           # list ad sets
meta-ads://act_<id>/adsets/<adset_id>                # one ad set
meta-ads://act_<id>/ads                              # list ads
meta-ads://act_<id>/ads/<ad_id>                      # one ad
meta-ads://act_<id>/creatives                        # list creatives
meta-ads://act_<id>/creatives/<creative_id>          # one creative
meta-ads://act_<id>/audiences                        # list custom audiences
meta-ads://act_<id>/audiences/<audience_id>          # one audience
meta-ads://act_<id>/insights?level=campaign&date_preset=last_30d&breakdowns=age,gender
meta-ads://act_<id>/catalogs                         # list product catalogs
meta-ads://act_<id>/pixel-events?start=...&end=...   # pixel event stats
meta-ads://businesses                                # list business managers user belongs to
meta-ads://biz_<id>/assets                           # BM assets (ad accounts, pages, pixels)
```

### 5.2 Query params

All list/insights resources accept:
- `?cursor=<after_cursor>` — next-page cursor (returned by previous read as `next_cursor`).
- `?limit=<n>` — page size override (caps at `100`).
- `?fields=<comma_separated>` — override default field selection.

Insights additionally accepts the full Meta query surface: `level`, `date_preset` OR (`time_range.since`, `time_range.until`), `time_increment`, `breakdowns`, `action_breakdowns`, `action_attribution_windows`, `use_unified_attribution_setting`, `filtering`.

### 5.3 Per-resource response shape

Single objects → JSON-as-text.
List endpoints with cursor → JSON-as-text with `{ data: [...], next_cursor: "..." }`.
Insights endpoints with rectangular tabular shape → **TSV** (see §6.5).

### 5.4 Docs: switching surface

`docs/MIGRATION.md` (companion file) documents:
- How to swap a read resource for a `read_<X>` tool if your client doesn't support resources well.
- How to use the raw escape hatches `raw_graph_get` / `raw_graph_post` if you need a surface that's not exposed yet.

---

## 6. Tools

### 6.1 Mutation tools (all writable, no gate)

Every mutation tool description starts with **⚠️ WRITE OPERATION** (parity with mcp-gads convention) so MCP clients render the permission prompt clearly.

#### Campaigns
- `create_campaign(act_id, name, objective, status, special_ad_categories, ...)`
- `update_campaign(campaign_id, { name?, daily_budget?, lifetime_budget?, status?, bid_strategy?, ... })`
- `pause_campaign(campaign_id)` / `resume_campaign(campaign_id)`
- `archive_campaign(campaign_id)` / `delete_campaign(campaign_id)`
- `duplicate_campaign(campaign_id, { name?, status?, deep_copy? })`

#### Ad Sets
- `create_adset(act_id, campaign_id, name, optimization_goal, billing_event, targeting, ...)`
- `update_adset(adset_id, partial)`
- `pause_adset` / `resume_adset` / `archive_adset` / `delete_adset`
- `duplicate_adset`

#### Ads
- `create_ad(act_id, adset_id, name, creative, status, ...)`
- `update_ad(ad_id, partial)`
- `pause_ad` / `resume_ad` / `archive_ad` / `delete_ad`

#### Creatives
- `upload_image(act_id, image_path)` → returns `image_hash`.
- `upload_video(act_id, video_path)` → returns `video_id` after transcoding completes (polled).
- `create_creative(act_id, { name, object_story_spec | asset_feed_spec, ... })`
- `update_creative(creative_id, partial)`

#### Audiences
- `create_custom_audience(act_id, name, subtype, ...)`
- `add_users_to_audience(audience_id, { emails?, phones?, names?, dobs?, ... })` — **server hashes raw PII per Meta spec.**
- `remove_users_from_audience(audience_id, { emails?, ... })`
- `create_lookalike(act_id, source_audience_id, country, ratio)`
- `update_audience(audience_id, partial)` / `delete_audience(audience_id)`
- Optional: `share_audience(audience_id, target_business_id)`.

#### Targeting helpers (read-only, but tools rather than resources because they're parameterized lookups)
- `search_interests(query, limit?)`
- `search_geo_locations(query, types?, limit?)` — countries, regions, cities, zips.
- `search_behaviors(query)`
- `build_targeting({ countries?, regions?, age_min?, age_max?, genders?, interests?, behaviors?, custom_audiences?, exclude_custom_audiences?, device_platforms?, publisher_platforms?, ... })` → returns a Meta-shaped `targeting` object.

#### Conversions API
- `send_conversion_events(pixel_id, events[], test_event_code?)` — events are an array of `{ event_name, event_time, action_source, user_data: { ... raw PII, hashed by server ... }, custom_data, event_id, ... }`.
- `read_pixel_events(pixel_id, start, end)` — wraps insights for pixel.

#### Catalogs & DPA
- `list_catalogs(business_id)`
- `list_product_sets(catalog_id)`
- `create_dpa_creative(act_id, catalog_id, product_set_id, template_spec)`
- `update_product` / `bulk_upsert_products` (catalog write).

#### Escape hatches
- `raw_graph_get(path, params?)` — for anything not yet exposed.
- `raw_graph_post(path, body)` — same, write side. Documented as power-user; carries the same ⚠️ marker.

### 6.2 Insights tool (alongside the resource)

The resource path covers most reads. For very complex queries it's awkward to encode in a URI, so there's a tool wrapper:

- `run_insights(act_id, { level, fields, breakdowns?, action_breakdowns?, time_range OR date_preset, time_increment?, action_attribution_windows?, filtering?, use_unified_attribution_setting?, limit? })`
  - Returns TSV by default.
  - If Meta returns "this query must be async" (or estimated rows × cols > heuristic threshold), the server transparently POSTs an async report job, polls (exponential backoff up to `META_ADS_INSIGHTS_ASYNC_POLL_MS`), and returns the final dataset.
  - If the poll exceeds `META_ADS_INSIGHTS_ASYNC_TIMEOUT_MS`, returns the `report_run_id` so the caller can resume with `get_insights_job(report_run_id)`.
- `get_insights_job(report_run_id)` — resume / inspect an async job started elsewhere.

### 6.3 Annotations

All tools include MCP annotations (`destructiveHint`, `idempotentHint`, `readOnlyHint`, `openWorldHint: true`) so clients can render permission prompts intelligently — parity with the recent `mcp-gads` v0.6.0 work (`feat(tools): add MCP annotations so clients can render permission prompts`).

### 6.4 Tool naming

`snake_case`. No prefix (the server name is `meta-ads` so client UI namespaces them). Consistent with mcp-gads.

### 6.5 Output format rule

| Response shape | Format |
|---|---|
| Single object (campaign, ad set, creative, audience details) | JSON-as-text, pretty-printed (`JSON.stringify(obj, null, 2)`) |
| List with cursor | JSON-as-text: `{ data: [...], next_cursor?: string }` |
| Insights tabular (rectangular: 1 row per breakdown × time bucket) | **TSV** with a header row, columns in the order the caller requested `fields` |
| Targeting / spec objects | JSON-as-text (nested by nature) |
| Error | JSON-as-text: `{ error: { message, type, code, subcode?, fbtrace_id? } }` with a `hint` field added by `utils/errors.ts` translating common subcodes |

Why TSV not CSV: insights field values can contain commas (e.g. `"action_destination": "Page, IG account"`); TSV is much less prone to quoting headaches.

---

## 7. Graph API client (`services/meta-graph-api.ts`)

### 7.1 Responsibilities

1. Build URL: `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${path}`.
2. Apply auth: bearer header + optional `appsecret_proof`.
3. Issue request, parse JSON.
4. Inspect `X-Business-Use-Case-Usage` + `X-App-Usage` headers; record per-account counters.
5. Adaptive backoff: if any counter > `META_ADS_RATE_LIMIT_THRESHOLD`, sleep with jitter before returning (the request already succeeded; backoff protects the next call).
6. On 429 / `error.code === 4` / `error.code === 17` / `error.code === 32` / `error_subcode === 1487504` / `error_subcode === 2446079` / 5xx → exponential backoff retry (3 attempts, base 1s, factor 2, jitter 0–500ms).
7. Translate Meta error envelope to a typed `MetaApiError` with `code`, `subcode`, `message`, `fbtrace_id`, plus a human-readable `hint` from a lookup table for common subcodes.

### 7.2 Public API

```ts
export interface GraphRequestOptions {
  method?: "GET" | "POST" | "DELETE";
  params?: Record<string, string | number | boolean | string[]>;
  body?: Record<string, unknown> | FormData;
  // Insights-specific:
  insightsAutoAsync?: boolean;
}

export async function graphFetch<T>(
  path: string,
  opts?: GraphRequestOptions,
): Promise<T>;

export async function graphPaginate<T>(
  path: string,
  opts?: GraphRequestOptions,
): Promise<{ data: T[]; nextCursor?: string }>;

export async function uploadImage(actId: string, filePath: string): Promise<{ hash: string }>;
export async function uploadVideo(actId: string, filePath: string): Promise<{ id: string }>;
export async function runInsightsAsync(actId: string, query: InsightsQuery): Promise<InsightsRow[]>;
```

### 7.3 Async insights flow

```
POST /act_X/insights (with body of params, no fields read) → returns { report_run_id }
GET /report_run_id?fields=async_status,async_percent_completion → poll until async_status === "Job Completed"
GET /report_run_id/insights?...&limit=500 → fetch results page by page → concat
```

---

## 8. PII hashing for audiences

Per Meta's [customer file spec](https://developers.facebook.com/docs/marketing-api/audiences/guides/custom-audiences/) the server normalizes then SHA256-hashes:

| Field | Normalization |
|---|---|
| `email` | lowercase, trim |
| `phone` | digits only, retain country code, strip leading `+` and zeros |
| `first_name` / `last_name` | lowercase, strip accents, strip whitespace and punctuation, no `Mr/Mrs/Jr` |
| `dob` | `YYYYMMDD` |
| `city` | lowercase, strip whitespace, strip punctuation |
| `state` | 2-letter code, lowercase (US/CA), full lowercase otherwise |
| `zip` | first 5 chars (US), lowercase rest |
| `country` | 2-letter ISO, lowercase |
| `gender` | `m` or `f` |
| `madid` (mobile ad id) | lowercase, no further normalization |

All hashing happens in `services/pii.ts`. **No raw PII is logged.** Debug logs explicitly redact PII fields. Unit tests verify the normalization matches Meta's worked examples.

---

## 9. Error model

`utils/errors.ts` exports a `MetaApiError extends Error` with structured fields. The server response for tool errors uses the same JSON-as-text format described in §6.5. A lookup table provides `hint` strings for the most common subcodes:

| Code | Subcode | Hint |
|---|---|---|
| 4 | — | "Application request limit reached — backing off." |
| 17 | — | "User request limit reached for this account." |
| 32 | — | "Page-level throttling — retry after a short pause." |
| 100 | 33 | "Object doesn't exist or you don't have access." |
| 190 | — | "Access token invalid or expired — regenerate System User token in Business Manager." |
| 200 | — | "Permission denied — System User needs the appropriate role on the BM/ad account." |
| 270 | — | "App not allowed to call this endpoint — check `ads_management` permission." |
| 368 | — | "Temporarily blocked for policies violations." |
| — | 1487504 | "Throttle on insights — auto-async will engage." |

The table is extended over time as we hit new subcodes.

---

## 10. Phased release plan (Tier 4 doesn't ship in one go)

Tier 4 scope, broken into shippable releases. Each release follows the **CPTRP** cycle (Commit → Push → Tag → Release → Publish).

| Release | Includes |
|---|---|
| **v0.1.0** | Auth, env loading, Graph client (with rate limits + retries), resources for accounts/campaigns/adsets/ads/creatives/audiences (read-only), insights resource + `run_insights` tool with auto-async, raw escape hatches (`raw_graph_get/post`), basic mutation tools for campaigns (create/update/pause/resume/archive/delete). Annotations on every tool. |
| **v0.2.0** | Full ad set + ad mutation tools. Creative upload tools (`upload_image`, `upload_video`, `create_creative`). End-to-end "build a new ad" workflow possible. |
| **v0.3.0** | Custom audiences + lookalikes (with PII hashing). Targeting helpers (`search_interests`, `search_geo_locations`, `search_behaviors`, `build_targeting`). |
| **v0.4.0** | Conversions API (read pixel events + send_conversion_events with test/live). Pixel-level resources. |
| **v0.5.0** | Catalogs / product sets / DPA creatives. Bulk product upsert. |
| **v0.6.0** | Page engagement read (comments, page insights), business manager assets browsing, share_audience between BMs. |
| **v1.0.0** | Stable surface freeze. **Proper token caching** (see §16). Migration guide for any URI/tool renames. Docs polish, examples cookbook. |

### §16 sketch — token caching (v1.0 requirement)

Today: env var read once, memoized via `getEnv()`. Effectively zero caching beyond module-singleton state. Fine for stdio MCP where the server is one process per session.

What "proper token caching" should look like for v1.0:

- **Startup probe result cache** — `META_ADS_VALIDATE_AT_STARTUP=true` currently calls `GET /me` on every server boot. Cache the validation result keyed by a hash of the token, with a TTL (~24h), so repeated MCP restarts don't burn API calls.
- **`appsecret_proof` cache** — computed once per request from the token + app secret. Memoize across the process lifetime so we don't re-HMAC on every call.
- **`/me/adaccounts` cache** — the accounts list rarely changes. A 5-minute TTL cache lets the LLM call `meta-ads://accounts` repeatedly without hitting the API. Invalidate on any 401/403 (which means token state changed).
- **Per-token `/me` identity cache** — once we know who the token represents, that's stable until the token rotates. Cache for the process lifetime.
- **Future: OAuth refresh cache** — only relevant if we ever add OAuth (currently a non-goal, §15). At that point we'd need a token store with refresh-on-expire semantics, persisted to disk between MCP restarts.

Implementation note: caches MUST be keyed by `sha256(token)` so a token rotation invalidates everything. Never key by `account_id` alone — different tokens may have different visibility into the same account.

The version numbers mirror mcp-gads's recent cadence; nothing is load-bearing about them — just a guide.

---

## 11. Testing strategy

- **Unit:** `bun test` for `services/pii.ts` normalization rules (worked examples from Meta docs), `services/format.ts` JSON↔TSV, `utils/errors.ts` hint lookups, `utils/account-id.ts`.
- **Contract:** Fixtures of real Graph API responses captured to `tests/fixtures/` with all sensitive fields scrubbed. Replayed against `services/meta-graph-api.ts` to detect schema drift between version bumps.
- **Integration (manual gate):** Optional `bun run test:live` script that runs against a real ad account specified by `META_ADS_TEST_ACCOUNT_ID`. Off by default. CI never runs this.
- **Type:** `tsc --noEmit`.
- **Lint/format:** `biome check`.

---

## 12. CI / Release pipeline (mirrors mcp-gads)

- `.github/workflows/ci.yml`: typecheck + test on every PR / push to main.
- `.github/workflows/release.yml`: on tag push (`vX.Y.Z`), builds standalone binaries for `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64` via `bun build --compile`. Publishes GitHub Release with binaries attached.
- `npm publish` runs **locally** for now (no `NPM_TOKEN` secret on GitHub, same posture as mcp-gads). Wire up later if useful.
- `server.json` + `mcpName` in `package.json` mirror gads's MCP registry posture.

CPTRP release command sequence is unchanged from gads:

1. Commit → 2. Push to `origin/main` → 3. Tag `git tag vX.Y.Z && git push origin vX.Y.Z` → 4. GitHub Actions builds binaries + creates release → 5. `npm publish` locally.

---

## 13. Configuration files to scaffold

- `package.json` — copied from mcp-gads with `name: "mcp-meta-ads"`, `bin: { "mcp-meta-ads": "dist/index.js" }`, `mcpName: "io.github.pijusz/mcp-meta-ads"`, deps trimmed (drop `google-auth-library`).
- `tsconfig.json` — copy verbatim.
- `biome.json` — copy verbatim.
- `.gitignore` — copy verbatim.
- `.gitattributes` — copy verbatim.
- `.env.example` — Meta-specific env vars from §4.1.
- `LICENSE` — MIT, same as gads.
- `CLAUDE.md` — short, points to `AGENTS.md` (parity with gads's pattern).
- `AGENTS.md` — Meta-specific guidelines mirroring gads's structure.
- `README.md` — install / quickstart / common workflows / token setup. Includes "switching surface" docs link.
- `server.json` — MCP registry config.
- `.github/workflows/ci.yml` — copy from gads.
- `.github/workflows/release.yml` — copy from gads, swap binary name to `mcp-meta-ads`.

---

## 14. References / prior art

Reviewed during planning (none adopted wholesale; design choices above diverge intentionally where called out):

- **[pipeboard-co/meta-ads-mcp](https://github.com/pipeboard-co/meta-ads-mcp)** — Meta Ads MCP using a hosted auth service. Took the obvious `meta-ads-mcp` npm name. We're using `mcp-meta-ads` for symmetry with `mcp-gads`. Differences: we use self-managed System User tokens (no hosted dependency); resource-first read surface; TSV insights output.
- **[nowork-studio/toprank](https://github.com/nowork-studio/toprank)** — referenced for general MCP ad-platform patterns.
- **[irinabuht12-oss/google-meta-ads-ga4-mcp](https://github.com/irinabuht12-oss/google-meta-ads-ga4-mcp)** — combined Google/Meta/GA4 MCP. We're keeping Meta as its own package; a hypothetical aggregator can compose downstream.

---

## 15. Open questions / explicit non-goals

### Open
- **Webhooks for ad object changes** — Meta supports webhooks for changes to ad objects. Not in v0.x. Revisit when there's a real use case for push delivery vs. polling.
- **Multi-account batch operations** — Meta supports batch requests (`?batch=[...]`). Not exposed in v0.x; agents can parallelize at their layer. Revisit if rate-limit pressure makes batching attractive.
- **Hosted/remote MCP** — current spec assumes stdio + local file paths. If we ever move to a hosted server, asset upload must switch to URLs (§7 decision will need revisiting).
- **A/B testing / experiments** — Meta has a dedicated split-test API. Defer to v1.x.

### Non-goals
- **OAuth flow** — explicit no, per Decision #1. Re-enable only if a non-BM user audience materializes.
- **Mutation gating** — explicit no, per Decision #2. Re-enable if real users get burned and ask for it (and then it'd be a config-driven feature, not a default).
- **Bundling Google Ads + Meta** — that's the irinabuht repo's territory. We stay focused.

---

## 16. Appendix — Decision-record style

This document is the single source of truth for v0.x design. When a decision changes:

1. Update the row in §2 with the new choice + new rationale.
2. Update the affected sections.
3. Add a dated **changelog** entry below.

### Changelog
- **2026-05-11** — Initial draft. All 15 decisions from interview captured.
- **2026-05-11** — Bumped pinned Graph API version from `v23.0` → `v25.0` (released Feb 18, 2026; current stable as of bump date). Decision row #10 updated.
- **2026-05-11** — `docs/RESEARCH.md` §2.7 expanded with v24/v25 version-boundary deltas + 2025–2026 OCC timeline. Implementation checklist (§4) reorganized to mark completed items and add v24/v25-specific TODOs (`is_adset_budget_sharing_enabled`, `placement_soft_opt_out`, `destination_spec`, daily-budget +75% flexibility warning, async-job failure metadata, `smart_promotion_type` strip, flagged-audience preflight). Flagged the **2026-05-19 global Advantage+ enforcement deadline** (8 days out) — any campaign-creation work before then must not allow legacy ASC/AAC.
- **2026-05-11** — Campaign mutation tools shipped (`create_campaign`, `update_campaign`, `pause_campaign`, `resume_campaign`, `archive_campaign`, `delete_campaign`, `duplicate_campaign`). v25 async-job failure metadata wired through `pollAsyncJob` — failed insights jobs now surface `error_code` / `error_user_msg` instead of generic "Job Failed". Note `use_unified_attribution_setting` / `action_report_time` intentionally not exposed on insights API.
- **2026-05-11** — Added **§16 (token caching)** as a v1.0 release requirement: startup probe TTL cache, `appsecret_proof` memoization, `/me/adaccounts` TTL cache (5 min), per-token `/me` identity cache, all keyed by `sha256(token)`.
- **2026-05-11** — **v0.0.1 first release.** Tier 4 surface complete: campaign + ad set + ad mutations, creative upload, insights with auto-async, audiences (with PII hashing) + lookalikes, targeting helpers + builder, Conversions API, product catalogs / DPA, page engagement reads, business asset browsing, raw escape hatches. Token caching implemented per §16. Versioning posture: starting at `0.0.1` to keep semver headroom while we collect real-world feedback before committing to a stable `1.x` surface. Cookbook deferred to a `0.x` patch.
