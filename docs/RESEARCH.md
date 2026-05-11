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

## 2. Meta Marketing API v23.0 — implementation specifics

Release date: **May 29, 2025**. Sunset: ~Q3 2027. v24.0 (Oct 2025) and v25.0 (Feb 2026) bring breaking changes — see §2.7.

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

### 2.7 v23 breaking changes / posture

1. **`advantage_state` is read-only** on campaigns.
2. **`smart_promotion_type`** being removed in v25 — stop writing it.
3. **Advantage+ audience is default** for new ad sets. Pass `targeting_automation.advantage_audience = 0` to opt out.
4. **Age/gender are suggestions**, not constraints, under targeting automation.
5. **`instagram_destination_id` now returns `ig_user_id`** instead of `instagram_actor_id`.
6. **`is_sac_cfca_terms_certified` retracted** — stop sending (Aug 27, 2025).
7. **Attribution windows: 7d-view and 28d-view fully removed Jan 2026.** v23 still accepts them but returns zeros. **Default to `["1d_click", "7d_click"]`** only.
8. **`use_unified_attribution_setting` and `action_report_time` are ignored** as of Jun 10, 2025.
9. **Legacy ASC / AAC creation blocked in v24+.** v23 still allows. Migration field: `migrate_to_advantage_plus`.
10. **`special_ad_categories` required** for housing/employment/credit/social-issues — use `["NONE"]` if not applicable.

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

- [ ] **graphFetch** — already handles 4 / 17 / 32 / 613 retries. Add 80000 / 80001 / 80002 / 80004 to retryable set.
- [ ] **Async insights polling** — 10s base, exponential up to 15s, terminal status `Job Completed | Failed | Skipped`, abort at `META_ADS_INSIGHTS_ASYNC_TIMEOUT_MS`.
- [ ] **Default attribution windows** — `["1d_click", "7d_click"]` (drop view variants — removed Jan 2026).
- [ ] **`use_unified_attribution_setting`** — strip from any caller-supplied params (ignored since Jun 10, 2025).
- [ ] **Compact mode** — `run_insights({ compact: true })` strips `omni_*` action duplicates.
- [ ] **Breakdown auto-fix** — `platform_position` → ensure `publisher_platform`; `media_type` → clear `action_breakdowns`.
- [ ] **Video upload** — use Resumable Upload API path, not legacy chunked.
- [ ] **Special ad categories** — when creating a campaign, accept `special_ad_categories?: string[]` and require `["NONE"]` if the caller doesn't pass it for non-restricted verticals.
- [ ] **Custom audience batching** — surface `session_id` / `batch_seq` / `last_batch_flag` correctly across multi-call uploads. Cap rows at 10,000 per request.
- [ ] **`adinterestvalid`** — call before any `targeting` mutation that uses interests.
- [ ] **PII hashing** — `services/pii.ts` already has the table; double-check against §2.6 + §2.8 when we wire it up.
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
