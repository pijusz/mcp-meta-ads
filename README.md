# mcp-meta-ads

Meta (Facebook) Ads MCP server — manage campaigns, ad sets, ads, creatives, audiences & insights via natural language.

Built with Bun + TypeScript. Works with Claude, Cursor, and any MCP client.

> **Status:** v0.x — pre-release scaffold. See [docs/SPEC.md](docs/SPEC.md) for design decisions and roadmap.

---

## Quick Start

### 1. Get a System User access token

This MCP uses a **Business Manager System User token** (long-lived, effectively non-expiring unless revoked). No OAuth flow needed.

1. In [Business Manager](https://business.facebook.com/) → Business Settings → System Users → create a System User.
2. Assign it the ad accounts you want to manage (with **Admin** access).
3. Add the **`ads_management`** and **`ads_read`** permissions.
4. Generate an access token; copy it.

### 2. Add to Claude Code

```bash
claude mcp add meta-ads --scope user --transport stdio \
  -e META_ADS_ACCESS_TOKEN=your-system-user-token \
  -- npx -y mcp-meta-ads@latest
```

Restart Claude Code and the tools/resources are available.

> Also works with `bunx mcp-meta-ads@latest` if you have [Bun](https://bun.sh/).
> Requires Node 18+ when running via `npx`.

### 3. Verify

```bash
npx -y mcp-meta-ads@latest --version
```

---

## Surface

This server is **resource-first** for reads, **tool-first** for mutations.

### Resources (reads)

```
meta-ads://accounts                                  # ad accounts you can access
meta-ads://act_<id>                                  # account details
meta-ads://act_<id>/campaigns[?cursor=...]
meta-ads://act_<id>/campaigns/<campaign_id>
meta-ads://act_<id>/adsets[?cursor=...]
meta-ads://act_<id>/ads[?cursor=...]
meta-ads://act_<id>/creatives[?cursor=...]
meta-ads://act_<id>/audiences[?cursor=...]
meta-ads://act_<id>/insights?level=campaign&date_preset=last_30d&breakdowns=age,gender
meta-ads://businesses
meta-ads://biz_<id>/assets
```

### Tools (mutations + parameterized lookups)

- **Campaigns:** `create_campaign`, `update_campaign`, `pause_campaign`, `resume_campaign`, `archive_campaign`, `delete_campaign`, `duplicate_campaign`
- **Ad Sets / Ads:** create / update / pause / resume / archive / delete (same shape)
- **Creatives:** `upload_image`, `upload_video`, `create_creative`, `update_creative`
- **Audiences:** `create_custom_audience`, `add_users_to_audience`, `remove_users_from_audience`, `create_lookalike`
- **Insights:** `run_insights` (with auto-async), `get_insights_job`
- **Targeting helpers:** `search_interests`, `search_geo_locations`, `search_behaviors`, `build_targeting`
- **Conversions API:** `send_conversion_events`, `read_pixel_events`
- **Catalogs / DPA:** `list_catalogs`, `list_product_sets`, `create_dpa_creative`, `bulk_upsert_products`
- **Escape hatches:** `raw_graph_get`, `raw_graph_post`

Mutation tools have `⚠️ WRITE OPERATION` prefix in their descriptions so MCP clients render the permission prompt clearly. **There is no mutation gate** — if the token is wired up, all mutations are live.

---

## Configuration

| Env | Required | Default | Notes |
|---|---|---|---|
| `META_ADS_ACCESS_TOKEN` | ✓ | — | System User token from Business Manager. |
| `META_ADS_APP_SECRET` | optional | — | Enables `appsecret_proof` on every request (recommended). |
| `META_GRAPH_API_VERSION` | optional | `v23.0` | Override the pinned API version. |
| `META_ADS_VALIDATE_AT_STARTUP` | optional | `false` | Run `GET /me` at startup to fail fast on bad tokens. |
| `META_ADS_RATE_LIMIT_THRESHOLD` | optional | `75` | % of any usage counter that triggers proactive backoff. |
| `META_ADS_DEFAULT_PAGE_SIZE` | optional | `25` | Per-page result count for paginated reads. |
| `META_ADS_INSIGHTS_ASYNC_TIMEOUT_MS` | optional | `120000` | Abort async insights polling after this. |
| `META_ADS_INSIGHTS_ASYNC_POLL_MS` | optional | `2000` | Base poll interval (exp backoff up to 15s). |
| `META_ADS_LOG_LEVEL` | optional | `warn` | `error` \| `warn` \| `info` \| `debug`. |
| `META_ADS_REQUIRE_PREHASHED` | optional | `false` | Refuse raw PII; require callers to pre-hash. |

---

## Project status & roadmap

See [docs/SPEC.md](docs/SPEC.md) §10 for the phased release plan. v0.1 ships reads + campaign mutations; later releases layer in ad set/ad/creative mutations, audiences, CAPI, catalogs.

---

## Sibling project

[mcp-gads](https://github.com/pijusz/mcp-gads) — same author, Google Ads MCP, mirrors this project's design.

---

## License

MIT
