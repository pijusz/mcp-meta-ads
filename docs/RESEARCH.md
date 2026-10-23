# Research notes — mcp-meta-ads

Compiled 2026-05-11 from three parallel research agents during scaffolding. Captures the *non-obvious* technical details we didn't already know going in. Cite this doc when implementing tools/resources so we don't re-discover the same gotchas.

---

## 1. MCP TypeScript SDK — resources API

SDK pin: `@modelcontextprotocol/sdk@1.29.0`. Spec date: `2025-06-18`.

### Use `registerResource` (not `resource`)

```ts
server.registerResource(
  "meta-campaign",
  new ResourceTemplate("meta-ads://act_{accountId}/campaigns/{campaignId}", {
    list: undefined, // do not enumerate; rely on tools to surface IDs
  }),
  {
    title: "Meta Ads Campaign",
    description: "Campaign details + recent performance",
    mimeType: "application/json",
    annotations: { audience: ["assistant"], priority: 0.7 },
  },
  async (uri, { accountId, campaignId }) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(...) }],
  }),
);
```

### Dynamic listing

For runtime-known IDs (every campaign in every account), **do not** enumerate in `list`. Register a `ResourceTemplate` with `list: undefined` and let tools surface IDs. Use `list: <callback>` only for small top-level enumerations (e.g. accessible ad accounts under `meta-ads://accounts`).

### Client support — late 2025 / early 2026

| Client | Resource support |
|---|---|
| Claude Code | ✓ via `@`-mention; supports `notifications/resources/list_changed` |
| Claude Desktop | ✓ attachment picker; runtime URIs limited |
| Cursor | ⚠️ flaky — resource templates reportedly not surfaced; sometimes sends `resources/subscribe` to stateless servers |

**Implication:** for any read that needs to be discoverable from a clean conversation, expose a tool equivalent alongside the resource.

### Annotations on resources

Available in 1.29.0. Pass inside the `metadata` arg:

```ts
annotations: {
  audience?: ("user" | "assistant")[],
  priority?: number, // 0.0–1.0
  lastModified?: string, // ISO 8601 with offset
}
```

**Tool hints (`destructiveHint`, `idempotentHint`, etc.) do not apply to resources** — resources are read-only by spec.

### To verify in code

- Whether `ListResourcesCallback` actually receives/returns a pagination cursor in 1.29.0 — spec supports it but SDK signature doesn't show a cursor param. Check `src/server/mcp.ts` directly when we start implementing.
- Whether `notifications/resources/list_changed` is auto-emitted when a `ResourceTemplate.list` callback's output changes, or whether we must call `server.sendResourceListChanged()` manually.

---

## 2. Meta Marketing API v23.0+ — implementation specifics

> **Pin update (2026-05-11):** Default `META_GRAPH_API_VERSION` is now **`v25.0`** (released Feb 18, 2026; current stable). The v23-specific path examples below remain illustrative — endpoint shapes are stable across v23→v25. §2.7 lists what changed at each version boundary.

Release dates: **v23.0** May 29, 2025 · **v24.0** Oct 8, 2025 · **v25.0** Feb 18, 2026. Each version typically lives ~2 years, so v23 sunsets ~Q3 2027.

### 2.1 Async insights flow

**Start:** `POST /v23.0/act_{ACCOUNT_ID}/insights?fields=...&level=...&time_range={...}&breakdowns=...`

→ `{ report_run_id }`. **Expires after 30 days** — don't persist.

**Poll:** `GET /v23.0/{report_run_id}` returns `async_status`, `async_percent_completion`.

**`async_status` values (case-sensitive):**

- `Job Not Started`
- `Job Started`
- `Job Running`
- `Job Completed` ← success
- `Job Failed`
- `Job Skipped`

Terminal: `Completed` | `Failed` | `Skipped`. From v25.0 (Feb 18, 2026) failures will include `error_code` / `error_message` / `error_subcode` / `error_user_title` / `error_user_msg`. Until then, opaque.

**Fetch results:** `GET /v23.0/{report_run_id}/insights?limit=1000`. Default page is 25; bump to 500–1000.

**Polling cadence:** 10s. Async jobs can take up to ~1 hour.

**What forces async** (Meta doesn't publish a hard threshold; sync returns "reduce amount of data" or code 1/subcode 99):

- `time_increment=1` over > 90 days
- `level=ad` over wide ranges with breakdowns
- multiple high-cardinality breakdowns (e.g. `age,gender,publisher_platform,region`)
- any request whose internal cost exceeds the per-call cap

### 2.2 Rate-limit headers

| Header | Purpose |
|---|---|
| `X-App-Usage` | Legacy app-level counter — `{ call_count, total_time, total_cputime }` all 0–100 |
| `X-Business-Use-Case-Usage` | **Canonical** for Marketing API — keyed by business/account ID, array of `{ type, call_count, total_cputime, total_time, estimated_time_to_regain_access, ads_api_access_tier }` |
| `X-FB-Ads-Insights-Throttle` | Insights-specific — `{ app_id_util_pct, acc_id_util_pct, ads_api_access_tier }` |
| `X-Ad-Account-Usage` | Legacy Ads API v3.3-era |

`type` values in BUC: `ads_management` · `ads_insights` · `custom_audience` · `pages` · `instagram` · `messenger`.

`estimated_time_to_regain_access` is in **minutes** — informational only.

Access tiers: `development_access` (~300 ads_management calls/hr/account, ~600 ads_insights) vs `standard_access` (100,000 / 190,000 base with ~40×/400× active-ads multipliers).

### 2.3 Throttle error codes

| Code | Subcode | Meaning |
|---|---|---|
| 4 | — | App-level rate limit exceeded |
| 17 | 2446079 | User request limit (per-user token) |
| 32 | — | Page-level rate limit |
| 80000 | 2446079 | Ads Insights BUC limit |
| 80001 | — | Pages BUC limit |
| 80002 | — | Custom Audience BUC limit |
| 80004 | 2446079 | Ads Management BUC limit |
| 613 | — | Calls per second exceeded (insights specific) |

### 2.4 Common error codes

(Already mostly captured in `src/utils/errors.ts`; expand as we hit new ones.)

Notable additions from research:

| Code | Subcode | Meaning |
|---|---|---|
| 100 | 1487006 | Invalid parameter — generic; check field shape |
| 100 | 1487079 | Invalid ad creative spec |
| 100 | 1487390 | "Adcreative Create Failed" — bad combination of fields |
| 100 | 1487504 | Ad creative missing call-to-action or required object_story_spec field |
| 100 | 1815105 | Invalid ad image/video reference |
| 190 | 458 | App not installed for user |
| 190 | 460 | Password changed → token invalid |
| 190 | 463 | Token expired |
| 190 | 467 | Token invalid (revoked/logged out) |
| 294 | — | Requires `ads_management` permission |

### 2.5 Asset upload

**Images — `POST /v23.0/act_X/adimages`:**

- `bytes=<base64>` body, OR
- `url=<https url>` (Meta fetches and hashes — note: `url_to_hash` is the legacy alias)
- multipart/form-data with file under any field name works; field name becomes `filename`
- Response: `{ images: { "<filename>": { hash, url } } }`
- Limits: 8 MB; JPG / PNG / GIF

**Videos — Resumable Upload API (recommended over legacy chunked):**

```
POST /v23.0/{APP_ID}/uploads?file_name=...&file_length=...&file_type=video/mp4
  → { id: "upload:..." }  # session handle

POST /v23.0/{upload-session-id}
  Authorization: OAuth <token>
  file_offset: 0
  body: <binary>
  → { h: "<file_handle>" }  # use as video_file_handle
```

Single-shot `source=<local path>` via multipart also works for < ~1 GB. Hard ceiling: ~10 GB / 4 hours.

**Poll transcoding:** `GET /v23.0/{video_id}?fields=status`. Wait for `video_status === "ready"` before referencing.

### 2.6 CAPI (Conversions API)

**Endpoint:** `POST /v23.0/{PIXEL_ID}/events`

Required: `event_name`, `event_time`, `action_source`. If `action_source="website"`, also require `client_user_agent` + `event_source_url`.

**user_data keys + hashing:**

| Key | Field | Normalize then SHA256 |
|---|---|---|
| `em` | email | trim, lowercase |
| `ph` | phone | digits only, no `+`, include country code |
| `fn` / `ln` | first/last name | lowercase, trim |
| `ge` | gender | `f` or `m`, lowercase |
| `db` | date of birth | `YYYYMMDD` |
| `ct` | city | lowercase, strip spaces/punct |
| `st` | state | lowercase 2-letter code |
| `zp` | zip | first 5 digits (US), lowercase rest |
| `country` | country | lowercase 2-letter ISO |
| `external_id` | external ID | hash recommended, raw accepted |

**Do NOT hash:** `client_ip_address`, `client_user_agent`, `fbc`, `fbp`.

**Dedup:** `event_id` must match Pixel `eventID` to dedupe browser + CAPI. 48h dedup window.

**Test events:** `test_event_code` at request body top level (not inside `data[]`).

### 2.7 Breaking changes by version

We're pinned to **v26.0** (bumped 2026-10-23). The relevant version-boundary deltas:

#### ⏰ Imminent enforcement deadlines (2026)

| Date | Change | Impact |
|---|---|---|
| **2026-05-19** | Legacy Advantage+ Shopping (ASC) / Advantage+ App (AAC) **create / duplicate / update** blocked on **every live version** (was v24+ only) | Hardens the v24-only block into a global one. After this date, even v23 callers can't touch legacy ASC/AAC. Use `migrate_to_advantage_plus`. |
| **2026-01-12** ✅ past | `7d_view` + `28d_view` attribution windows fully removed | Done. Default to `["1d_click","7d_click"]` — already enforced in `services/insights.ts`. |
| **2026-01-15** ✅ past | Pre-2025-10-08 detailed-targeting interests stop delivering | Campaigns with affected interests halted. Duplicating auto-rewrites to the consolidated option. |
| **2026-01-06** ✅ past | Flagged custom audience / custom conversion updates fail on **every live version** | Started v24-only Oct 2025; now global. Affects any campaign mutation that references a flagged audience. |
| **2025-09-09** ✅ past | Pre-v22 Graph API calls rejected | Anything pinned older than v22.0 stopped working. We pin v25 so N/A. |

#### v23.0 (May 29, 2025) — original baseline

- **`advantage_state` is read-only** on campaigns.
- **`instagram_destination_id` now returns `ig_user_id`** (was `instagram_actor_id`).
- **Advantage+ audience is default** for new ad sets. Pass `targeting_automation.advantage_audience = 0` to opt out.
- **Age/gender are suggestions**, not constraints, under targeting automation.
- **`special_ad_categories` required** for housing / employment / credit / social-issues verticals. Use `["NONE"]` if not applicable.

#### v24.0 (Oct 8, 2025)

**Removed / deprecated:**

- **Legacy ASC / AAC creation BLOCKED** — migrate via `migrate_to_advantage_plus` (preserves campaign ID). Becomes global on 2026-05-19.
- **Messenger lead ads via API.** `POST /{page-id}/messenger_lead_forms`, `POST /{ad-account-id}/adcreatives`, and `GET /{messenger-lead-gen-template-id}` no longer allow creating lead-gen ads that deliver into Messenger. Ads Manager creation still works.
- **Facebook Video Feeds placement.** Delivery halted; setting this placement in `adsets` POST/PATCH returns errors. Reels is the replacement. Affects existing campaigns too.

**New fields / parameters:**

- **`is_adset_budget_sharing_enabled`** — conditionally required when setting ad-set–level budget. Set `true` to allow Meta to lend up to 20% of the ad set's budget to siblings in the same campaign (non-CBO only).
- **`placement_soft_opt_out`** (ad set level) — allows up to 5% of spend to flow to *excluded* placements when Meta predicts a lift. Sales + Leads objectives only.
- **`allow_upsert`** on `POST /{product-catalog-id}/products` — upsert semantics for product items.
- **`destination_spec`** on ad creatives — Meta auto-picks the optimal landing page. Implicit for new creatives. Query via `GET /{ad-creative-id}?fields=destination_spec` to see what got resolved.
- **`lookalike_spec` stricter validation** — invalid subfields now fail at creation (was previously lenient).

**Default behavior changes:**

- ⚠️ **Daily budget flexibility 25% → 75%.** Daily spend can swing up to **+75%** above the daily amount as long as the weekly cap holds. Anomaly-detection / budget-monitoring code that assumed ≤25% over-spend per day **will misfire** — surface this in `update_campaign` budget tools when they land.
- **Website Destination Optimization** implicitly on for new creatives (via `destination_spec`).

**Limits:**

- **Catalog Items Batch API:** request payload cap **30 MB** (item count cap of 5,000 unchanged).

#### v25.0 (Feb 18, 2026)

- **`smart_promotion_type` removed** from campaign creation. Strip from caller-supplied bodies.
- **Async insights failure metadata.** `GET /{report_run_id}` returns `error_code`, `error_message`, `error_subcode`, `error_user_title`, `error_user_msg` when `async_status === "Job Failed"`. Wire through `pollAsyncJob()` so we surface the real reason — currently we throw a generic "Job Failed" message.
- **`error_code` type widened: `uint` → `int`** on `GET /{ad-report-run-id}`. Negative values are now possible — typed-language SDKs need to widen the field. Our code uses `number` (signed) so fine.
- **Legacy ASC/AAC block extends globally on 2026-05-19** (see deadlines table above).

#### v26.0 (Jul 29, 2026) — **current pin**

Source: developers.facebook.com/documentation/ads-commerce/marketing-api/marketing-api-changelog/version26.0 (the old `/docs/marketing-api/...version26.0` URL 404s) and /docs/graph-api/changelog/version26.0. Several items apply to **all versions on 2026-10-27**.

- **Lookalike `country` / `location_spec` ignored** (all versions, 2026-09-01): Meta creates a countryless lookalike; locations come from the ad set. `create_lookalike` no longer sends `country` (param kept optional, deprecated).
- **Explicit `targeting_automation.advantage_audience`** required for HEC/financial ad sets with constrained targeting (error `ADS_TARGETING__REQUIRE_EXPLICIT_ADVANTAGE_AUDIENCE_FLAG`). `create_adset` / `update_adset` take an `advantage_audience: 0|1` param.
- **Placements:** Instagram Explore feed removed (v26+, explicit use errors); Messenger Stories (`story` in `messenger_positions`) silently dropped. `build_targeting` doesn't emit positions, so no code change; noted in tool descriptions.
- **Shops Ads default:** eligible creatives default to `destination_spec.destination_type = WEBSITE_AND_SHOP`; opt out with `WEBSITE_AND_SHOP_OPT_OUT`. Noted in `create_creative`.
- **Poll ads removed** (`poll_spec`, `interactive_components_spec` type `poll`) and **`applink_treatment=web_only`** disallowed for Web+App campaigns (all versions 2026-10-27). Not used by our code; noted in descriptions.
- **Delivery estimate** `daily_outcomes_curve` / `budget_guardrail` / `estimate_dau` removed. Not used.
- **Graph protocol:** `pretty` / `debug` ignored, `date_format` and root `GET /?ids=` error, ETag/304 removed. Our client uses none of these (only `raw_graph_get` could pass them through).
- **Pages (New Pages Experience):** `current_location`, `genre`, `network`, `parking`, `start_info` error. Not requested by our code.
- **Commerce Order Management API** removed. Not used.
- Version table: v25.0 available until **2027-02-23**, v24.0 until 2026-11-10.

#### Out-of-cycle changes (apply across all live versions)

| Effective | Change |
|---|---|
| **2025-03** | Sensitive-category interest taxonomy pruned. Many interest IDs silently return empty. Always call `adinterestvalid` before targeting. |
| **2025-06-10** | `use_unified_attribution_setting` and `action_report_time` **ignored** — responses always mirror ad-set-level settings. Strip from caller params. |
| **2025-06-10** | **Reach retention cap.** When `reach` is requested with any breakdown, lookback is capped at **13 months** (was 37). |
| **mid-2025** | Insights API enforces Ads-Manager-style attribution by default; on-Facebook conversions count at impression time. To get the old behavior, **explicitly pass `action_attribution_windows`** — which `services/insights.ts` already does. |
| **2025-08-27** | `is_sac_cfca_terms_certified` / `is_eligible_for_sac_campaigns` retracted (Special Ad Category certification rollout walked back). Stop sending. |

#### Sunset clocks

Meta keeps each version live for ~2 years. Third-party recaps cite **v22.0 sunset 2026-02-10** (one week before v25 shipped) — **not confirmed from a Meta-hosted source**; verify if a user needs to stay on v22. v23/v24/v25 sunsets aren't published yet.

| Version | Released | Expected sunset |
|---|---|---|
| v22.0 | Jan 2025 | ~Feb 2026 (third-party, unverified) |
| v23.0 | May 29, 2025 | ~Q3 2027 |
| v24.0 | Oct 8, 2025 | ~Q4 2027 |
| v25.0 | Feb 18, 2026 | 2027-02-23 (Meta version table) |
| v26.0 | Jul 29, 2026 | TBD |

#### Caveats on this section

- OCC-2025 and the Marketing API v24/v25 changelog pages truncated repeatedly during research. Items above are cross-referenced against Meta's blog, releasebot.io, ppc.land, and dojoai but should be re-verified against `developers.facebook.com/docs/marketing-api/marketing-api-changelog/version2{4,5}.0/` before code depends on a specific date.
- **New error subcodes for v24/v25 weren't published in any reachable source.** Update `utils/errors.ts` as we discover them empirically.
- `lookalike_spec` strict validation: releasebot dates to v24, one snippet to v25 — treat as v24.

### 2.8 Custom audience customer file upload

`POST /v23.0/{AUDIENCE_ID}/users`:

```json
{
  "payload": {
    "schema": ["EMAIL_SHA256", "PHONE_SHA256"],
    "data": [["<hash>", "<hash>"], ...]
  },
  "session": {
    "session_id": 1234567890,
    "batch_seq": 1,
    "last_batch_flag": false,
    "estimated_num_total": 100000
  }
}
```

Schema tokens: `EMAIL` · `PHONE` · `GEN` · `DOBY` · `DOBM` · `DOBD` · `LN` · `FN` · `FI` · `CT` · `ST` · `ZIP` · `COUNTRY` · `MADID` · `EXTERN_ID`. Pre-hashed: `EMAIL_SHA256` · `PHONE_SHA256`.

Batch rules: ≤ 10,000 rows/request · same `session_id` across batches · `last_batch_flag=true` exactly once · `batch_seq` 1-indexed, monotonic.

### 2.9 Targeting search

`GET /v23.0/search?type=adinterest&q=...&limit=25&locale=en_US`

Other `type` values: `adgeolocation`, `adgeolocationmeta`, `adradiussuggestion`, `adzipcode`, `adTargetingCategory` (with `class=behaviors|demographics|interests`), `adinterestsuggestion`, `adinterestvalid`, `adlocale`, `adeducationmajor`, `adeducationschool`, `adworkemployer`, `adworkposition`, `adkeyword`.

**2025 deprecations:** Meta has been pruning the interest taxonomy (sensitive-category restrictions, March 2025). Many interest IDs silently return no results. Always call `adinterestvalid` before targeting.

---

## 3. Competitive analysis — what to steal / avoid

### Reference repos

- **[pipeboard-co/meta-ads-mcp](https://github.com/pipeboard-co/meta-ads-mcp)** — Python/FastMCP, 888⭐, hosted-SaaS-coupled auth (Pipeboard). 29 tools. No retries. No delete/archive. No custom audiences / CAPI / catalogs.
- **[nowork-studio/toprank](https://github.com/nowork-studio/toprank)** — *Not* an MCP server. It's a Claude Code plugin that consumes remote MCPs. Useful as a workflow-layer reference, not a server reference.
- **[irinabuht12-oss/google-meta-ads-ga4-mcp](https://github.com/irinabuht12-oss/google-meta-ads-ga4-mcp)** — Vaporware. 26 KB of marketing copy; no source code. Ignore.

### Steal (5)

1. **Compact mode on insights** — pipeboard's `compact: bool` strips `omni_*` action duplicates for ~60% smaller payload. Bake in from day one.
2. **Convenience ID aliases** — accept `account_id` / `campaign_id` / `adset_id` / `ad_id` as separate params on `run_insights` instead of forcing the LLM to construct a single `object_id`.
3. **Rate-limit observability** — parse all three usage headers, warn at threshold, **distinguish error code 4 (rate limit) from 190/200/270 (auth/permission)** so we don't invalidate auth state on a throttle.
4. **Resources for binary creatives** — `meta-ads://creatives/{hash}` for images, similar for videos. Don't return base64 in tool responses.
5. **Auto-fix incompatible breakdown combos** — pipeboard silently fixes `platform_position` → adds `publisher_platform`; `media_type` → clears `action_breakdowns`. LLMs get these wrong constantly.

### Avoid (5)

1. **Hosted-auth coupling** — keep env-var first, no phone-home. Pipeboard's "fetch fresh token every call from our service" is a moat builder, not a user feature.
2. **No retry/backoff** — Graph 5xx and code-4 throttles are routine. Ours has it (`graphFetch`).
3. **Generic `search` tool** — union-typed results confuse LLMs. Prefer narrow typed search tools.
4. **One 14-parameter fat `get_insights`** — useful as escape hatch, but ALSO ship resource-first views for the common cases.
5. **Skipping delete/archive/update_targeting** — pipeboard's gap. Ship them.

---

## 4. Implementation checklist seeded from research

For each phase in [SPEC.md §10](SPEC.md):

- [x] **graphFetch** — already handles 4 / 17 / 32 / 613 / 80000–80004 retries.
- [x] **Async insights polling** — 2s default base (`META_ADS_INSIGHTS_ASYNC_POLL_MS`), exponential up to 15s, terminal status `Job Completed | Failed | Skipped`, abort at `META_ADS_INSIGHTS_ASYNC_TIMEOUT_MS`.
- [x] **Default attribution windows** — `["1d_click", "7d_click"]` enforced in `services/insights.ts`.
- [x] **Compact mode** — `run_insights({ compact: true })` strips `omni_*` / `offsite_*` action duplicates.
- [x] **Breakdown auto-fix** — `platform_position` → ensures `publisher_platform`; `media_type` → clears `action_breakdowns`.
- [ ] **Async-job failure metadata (v25)** — `pollAsyncJob` should pull `error_code` / `error_message` / `error_subcode` / `error_user_title` / `error_user_msg` from the failed GET response and pass through to `MetaApiError`. Currently surfaces a generic "Job Failed" message.
- [ ] **`use_unified_attribution_setting`** — strip from caller params (ignored since 2025-06-10). Currently passed through.
- [ ] **Video upload** — use Resumable Upload API path, not legacy chunked.
- [ ] **Special ad categories** — when creating a campaign, accept `special_ad_categories?: string[]` and require `["NONE"]` if the caller doesn't pass it for non-restricted verticals.
- [ ] **`is_adset_budget_sharing_enabled` (v24)** — when create_adset sets a budget at the ad-set level, surface this param. Default `true` matches Meta's recommendation.
- [ ] **`placement_soft_opt_out` (v24)** — expose on `create_adset` for Sales/Leads objectives.
- [ ] **`destination_spec` (v24)** — read back on `meta-ads://act_X/adcreatives/{id}` to expose Meta's resolved landing page. Add to creative resource fields.
- [ ] **Daily budget +75% flexibility warning** — when `update_campaign` changes `daily_budget`, surface a hint that actual daily spend can be up to 75% over the cap (was 25% pre-v24). Important for any anomaly-detection downstream.
- [ ] **Catalog Items Batch payload cap** — `bulk_upsert_products` must split into ≤30 MB requests (item count cap still 5,000).
- [ ] **`allow_upsert` (v24)** — expose on `bulk_upsert_products` for create-or-update semantics.
- [ ] **`lookalike_spec` validation (v24)** — make sure our Zod schema for `create_lookalike` matches Meta's strict validation rules; otherwise users get cryptic errors.
- [ ] **`smart_promotion_type` strip (v25)** — if any caller-supplied campaign body contains this field, strip silently.
- [ ] **`adinterestvalid`** — call before any `targeting` mutation that uses interests (interest taxonomy pruned 2025-03).
- [ ] **Custom audience batching** — surface `session_id` / `batch_seq` / `last_batch_flag` correctly across multi-call uploads. Cap rows at 10,000 per request.
- [ ] **PII hashing** — `services/pii.ts` already has the table; double-check against §2.6 + §2.8 when we wire it up.
- [ ] **Flagged-audience preflight** — when creating/updating a campaign that references a custom audience or custom conversion, optionally pre-fetch the audience to check `delivery_status`. Otherwise the mutation fails with an opaque error (as of 2026-01-06, applies all versions).
- [ ] **2026-05-19 deadline reminder** — if our roadmap reaches campaign creation before then, ensure we never let the caller create legacy ASC/AAC (objective + structure that Meta would reject globally after the deadline). Today's date is 2026-05-11; 8 days out.
- [ ] **Error hints** — expand `utils/errors.ts` table with the new codes/subcodes (§2.3, §2.4).

---

## 5. Sources

### MCP SDK
- [MCP Spec — Resources (2025-06-18)](https://modelcontextprotocol.io/specification/2025-06-18/server/resources)
- [typescript-sdk v1.29.0 README](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/README.md)
- [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- [Cursor forum — MCP resources support](https://forum.cursor.com/t/mcp-resources-support/151758)

### Meta Marketing API
- [Marketing API Changelog v23.0](https://developers.facebook.com/docs/graph-api/changelog/version23.0)
- [Marketing API Rate Limiting](https://developers.facebook.com/docs/marketing-api/overview/rate-limiting/)
- [Graph API Rate Limiting](https://developers.facebook.com/docs/graph-api/overview/rate-limiting/)
- [Insights Best Practices](https://developers.facebook.com/docs/marketing-api/insights/best-practices/)
- [Async and Batch Requests](https://developers.facebook.com/docs/marketing-api/asyncrequests/)
- [Error Reference](https://developers.facebook.com/docs/marketing-api/error-reference/)
- [CAPI Parameters](https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters/)
- [Custom Audiences guide](https://developers.facebook.com/docs/marketing-api/audiences/guides/custom-audiences/)
- [Targeting Search](https://developers.facebook.com/docs/marketing-api/audiences/reference/targeting-search)
- [Video API publishing](https://developers.facebook.com/docs/video-api/guides/publishing/)
- [Ad Image reference](https://developers.facebook.com/docs/marketing-api/reference/ad-image/)
- [2025 OCC](https://developers.facebook.com/docs/marketing-api/out-of-cycle-changes/occ-2025/)
- [Ads Insights metric availability blog](https://developers.facebook.com/blog/post/2025/10/16/ads-insights-api-metric-availability-updates/)
