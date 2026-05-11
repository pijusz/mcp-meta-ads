<h1 align="center">mcp-meta-ads</h1>

<p align="center">
  Meta (Facebook) Ads MCP server — manage campaigns, ad sets, ads, creatives, audiences, pixels, catalogs & insights via natural language.
  <br/>
  Built with Bun + TypeScript. Works with Claude Code, Claude Desktop, Cursor, Codex, and any MCP client.
</p>

---

## Quick Start

### 1. Get a System User access token

This MCP uses a **Business Manager System User token**. No OAuth flow is required.

1. In [Business Manager](https://business.facebook.com/) → Business Settings → System Users → create a System User.
2. Assign it the ad accounts you want to manage, with the right asset access.
3. Add the permissions you need. Minimum useful scopes are usually `ads_read` and `ads_management`; Business Manager/catalog/page surfaces may also need `business_management`, `pages_read_engagement`, or `read_insights`.
4. Generate an access token and copy it.

### 2. Add to Claude Code

```bash
claude mcp add meta-ads --scope user --transport stdio \
  -e META_ADS_ACCESS_TOKEN=your-system-user-token \
  -- npx -y mcp-meta-ads@latest
```

That's it. Restart Claude Code and the tools/resources are available. Every session runs the latest published version automatically.

> Also works with `bunx mcp-meta-ads@latest` if you have [Bun](https://bun.sh/).
> Requires Node 18+ when running via `npx`.

If your environment blocks npm registry access at runtime, install once and run the published binary name directly:

```bash
npm i -g mcp-meta-ads@latest
claude mcp add meta-ads --scope user --transport stdio \
  -e META_ADS_ACCESS_TOKEN=your-system-user-token \
  -- mcp-meta-ads
```

### 3. Verify

```bash
npx -y mcp-meta-ads@latest --version
# or, after global install:
mcp-meta-ads --version
```

### Setup help

```bash
npx -y mcp-meta-ads@latest setup
```

This prints the token setup steps and example MCP configuration.

## ChatGPT Codex

Codex uses TOML, not JSON. Install once, then add to `~/.codex/config.toml`:

```bash
npm i -g mcp-meta-ads
```

```toml
[mcp_servers.meta_ads]
command = "mcp-meta-ads"

[mcp_servers.meta_ads.env]
META_ADS_ACCESS_TOKEN = "your-system-user-token"
```

Three gotchas that cause silent failures on Codex:

- **Don't use `npx -y` without raising the timeout.** Codex's default `startup_timeout_sec` is 10s, which is too short for npx's first-run download. A global install sidesteps this entirely. If you must use npx, add `startup_timeout_sec = 30`.
- **Env vars must go under `[mcp_servers.meta_ads.env]`.** Codex does not inherit the parent shell environment into stdio servers.
- **Use direct env values or absolute `.env` paths** via `META_ADS_ENV_FILE`; Codex starts servers with its own cwd.

## Claude Desktop / Cursor

Add to your MCP settings JSON:

<details>
<summary>Using npx (auto-updates)</summary>

```json
{
  "mcpServers": {
    "meta-ads": {
      "command": "npx",
      "args": ["-y", "mcp-meta-ads@latest"],
      "env": {
        "META_ADS_ACCESS_TOKEN": "your-system-user-token"
      }
    }
  }
}
```

</details>

<details>
<summary>Using global install</summary>

```json
{
  "mcpServers": {
    "meta-ads": {
      "command": "mcp-meta-ads",
      "env": {
        "META_ADS_ACCESS_TOKEN": "your-system-user-token"
      }
    }
  }
}
```

</details>

## Resources

This server is **resource-first** for reads and **tool-first** for mutations. List resources support `?cursor`, `?limit`, and `?fields` where applicable.

| Resource | Description |
|----------|-------------|
| `meta-ads://me` | Current System User identity |
| `meta-ads://accounts` | Ad accounts the token can access |
| `meta-ads://act_<id>` | Ad account details |
| `meta-ads://act_<id>/campaigns` | Campaign list |
| `meta-ads://act_<id>/campaigns/<campaign_id>` | Campaign details |
| `meta-ads://act_<id>/adsets` | Ad set list |
| `meta-ads://act_<id>/adsets/<adset_id>` | Ad set details, including targeting |
| `meta-ads://act_<id>/ads` | Ad list |
| `meta-ads://act_<id>/ads/<ad_id>` | Ad details |
| `meta-ads://act_<id>/creatives` | Ad creative list |
| `meta-ads://act_<id>/creatives/<creative_id>` | Creative details |
| `meta-ads://act_<id>/audiences` | Custom audiences and lookalikes |
| `meta-ads://act_<id>/audiences/<audience_id>` | Audience details |
| `meta-ads://act_<id>/adspixels` | Pixels associated with the ad account |
| `meta-ads://act_<id>/adspixels/<pixel_id>` | Pixel details |
| `meta-ads://act_<id>/insights?...` | TSV performance insights with auto-async fallback |

## Tools (57)

Mutation tools have a `⚠️ WRITE OPERATION` prefix in their descriptions so MCP clients render permission prompts clearly. **There is no mutation gate** — if the token is wired up, write tools are live.

### Raw Graph API
| Tool | Description |
|------|-------------|
| `raw_graph_get` | Escape hatch for arbitrary Graph API GET calls |
| `raw_graph_post` | Escape hatch for arbitrary Graph API POST calls |
| `raw_graph_delete` | Escape hatch for arbitrary Graph API DELETE calls |

### Insights
| Tool | Description |
|------|-------------|
| `run_insights` | Account/campaign/adset/ad insights with TSV or JSON output and auto-async fallback |
| `get_insights_job` | Inspect a Meta async insights report job |

### Campaigns
| Tool | Description |
|------|-------------|
| `create_campaign` | Create a campaign, defaulting to PAUSED |
| `update_campaign` | Partially update a campaign |
| `pause_campaign` | Set campaign status to PAUSED |
| `resume_campaign` | Set campaign status to ACTIVE |
| `archive_campaign` | Set campaign status to ARCHIVED |
| `delete_campaign` | Soft-delete a campaign |
| `duplicate_campaign` | Copy a campaign, optionally with child objects |

### Ad Sets
| Tool | Description |
|------|-------------|
| `create_adset` | Create an ad set with targeting, budget, optimization, billing, and promoted object fields |
| `update_adset` | Partially update an ad set |
| `pause_adset` | Set ad set status to PAUSED |
| `resume_adset` | Set ad set status to ACTIVE |
| `archive_adset` | Set ad set status to ARCHIVED |
| `delete_adset` | Soft-delete an ad set |
| `duplicate_adset` | Copy an ad set, optionally with child ads |

### Ads
| Tool | Description |
|------|-------------|
| `create_ad` | Create an ad from an existing or inline creative spec |
| `update_ad` | Partially update an ad |
| `pause_ad` | Set ad status to PAUSED |
| `resume_ad` | Set ad status to ACTIVE |
| `archive_ad` | Set ad status to ARCHIVED |
| `delete_ad` | Soft-delete an ad |

### Creatives
| Tool | Description |
|------|-------------|
| `upload_image` | Upload an image from a local path or public HTTPS URL |
| `create_creative` | Create an ad creative from `object_story_spec` or `asset_feed_spec` |
| `delete_creative` | Delete an unused ad creative |

### Audiences
| Tool | Description |
|------|-------------|
| `create_custom_audience` | Create a custom audience shell |
| `add_users_to_audience` | Add customer-file users; raw PII is normalized and SHA256-hashed locally |
| `remove_users_from_audience` | Remove customer-file users; raw PII is hashed locally before sending |
| `update_audience` | Update audience metadata |
| `delete_audience` | Delete a custom audience |
| `create_lookalike` | Create a lookalike audience from a source custom audience |

### Targeting Helpers
| Tool | Description |
|------|-------------|
| `search_interests` | Search Meta's ad-interest catalog |
| `search_geo_locations` | Search Meta geo-targeting locations and return targeting keys |
| `search_behaviors` | Browse/search behavioral targeting categories |
| `build_targeting` | Build a Meta targeting JSON spec from countries, age/gender, interests, behaviors, audiences, devices, and platforms |

### Conversions API / Pixels
| Tool | Description |
|------|-------------|
| `send_conversion_events` | Send server-side CAPI events to a Pixel; user_data PII is hashed locally |
| `read_pixel_events` | Read aggregate Pixel stats over a time window |
| `list_pixels` | List Pixels accessible from an ad account |

### Catalogs / Dynamic Product Ads
| Tool | Description |
|------|-------------|
| `list_catalogs` | List product catalogs owned by a Business Manager |
| `list_product_sets` | List product sets in a catalog |
| `create_catalog` | Create a product catalog |
| `create_product_set` | Create a product set inside a catalog |
| `bulk_upsert_products` | Batch create/update/delete catalog products through `/items_batch` |
| `delete_product_set` | Delete a product set |
| `delete_catalog` | Delete a catalog and its products/product sets |
| `create_dpa_creative` | Create a Dynamic Product Ad creative referencing a product set |

### Business Manager
| Tool | Description |
|------|-------------|
| `list_businesses` | List Business Managers visible to the token |
| `list_business_ad_accounts` | List owned/client ad accounts for a Business Manager |
| `list_business_pages` | List owned/client Pages for a Business Manager |
| `list_business_pixels` | List owned/client Pixels for a Business Manager |
| `list_business_system_users` | List System Users on a Business Manager |

### Page Engagement
| Tool | Description |
|------|-------------|
| `list_post_comments` | List comments on a Page/ad post, optionally with replies |
| `get_post_insights` | Read insights for a single post |
| `get_page_insights` | Read page-level insights |

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `META_ADS_ACCESS_TOKEN` | Yes | — | System User token from Business Manager |
| `META_ADS_ENV_FILE` | No | `.env` | Path to `.env` file (loaded if present, never overrides existing env) |
| `META_ADS_APP_ID` | No | — | Meta App ID; required only for `scripts/create-test-account.ts` |
| `META_ADS_APP_SECRET` | No | — | Enables `appsecret_proof` on every request |
| `META_GRAPH_API_VERSION` | No | `v25.0` | Meta Graph API version |
| `META_ADS_VALIDATE_AT_STARTUP` | No | `false` | Run a `GET /me` startup probe |
| `META_ADS_RATE_LIMIT_THRESHOLD` | No | `75` | Usage percentage that triggers proactive backoff |
| `META_ADS_DEFAULT_PAGE_SIZE` | No | `25` | Default page size for paginated reads |
| `META_ADS_INSIGHTS_ASYNC_TIMEOUT_MS` | No | `120000` | Async insights polling timeout |
| `META_ADS_INSIGHTS_ASYNC_POLL_MS` | No | `2000` | Base async insights poll interval |
| `META_ADS_LOG_LEVEL` | No | `warn` | `error`, `warn`, `info`, or `debug` |

### Live test variables

These are only for this repository's opt-in live tests; normal MCP usage does not need them.

| Variable | Description |
|----------|-------------|
| `META_ADS_RUN_LIVE_TESTS=true` | Enables `tests/live` |
| `META_ADS_TEST_ACCOUNT_ID` | Safe ad account for live tests |
| `META_ADS_TEST_BUSINESS_ATTACHED=true` | Enables Business-attached audience live tests |
| `META_ADS_TEST_PIXEL_ID` | Dedicated Pixel for CAPI live tests |
| `META_ADS_TEST_EVENT_CODE` | Events Manager → Test Events code |
| `META_ADS_ALLOW_CAPI_EVENT_WRITES=true` | Explicit acknowledgement that CAPI tests POST permanent events |

## Updates

**Using `npx @latest`** (recommended): you always get the latest version — no manual updates needed.

**Using global install**:

```bash
npm update -g mcp-meta-ads
mcp-meta-ads --version
```

The server checks GitHub Releases on startup and logs to stderr when a newer release is available.

## Development

Requires [Bun](https://bun.sh/).

```bash
git clone https://github.com/pijusz/mcp-meta-ads.git
cd mcp-meta-ads
bun install
bun test              # tests
bun run typecheck     # TypeScript
bun run lint          # Biome check
bun run build         # standalone Bun binary
bun run build:npm     # bundle for Node.js / npm
bun run inspect       # MCP Inspector
```

## Sibling projects

- [mcp-gads](https://github.com/pijusz/mcp-gads) — Google Ads MCP server.
- [mcp-redtrack](https://github.com/pijusz/mcp-redtrack) — RedTrack affiliate tracking MCP server.

## License

MIT
