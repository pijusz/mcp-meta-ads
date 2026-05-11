import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAccountResources } from "./accounts.js";
import { registerAdResources } from "./ads.js";
import { registerAdSetResources } from "./adsets.js";
import { registerAudienceResources } from "./audiences.js";
import { registerCampaignResources } from "./campaigns.js";
import { registerCreativeResources } from "./creatives.js";
import { registerInsightsResources } from "./insights.js";

/**
 * Resource registration barrel.
 *
 * Reads live behind `meta-ads://act_<id>/...` URIs (see docs/SPEC.md §5).
 *
 * Implementation notes (from docs/RESEARCH.md §1):
 *   - Use `server.registerResource(name, template, metadata, handler)`.
 *   - For runtime IDs (campaigns, ad sets, ads), register a ResourceTemplate
 *     with `list: undefined`. Rely on tools to surface IDs.
 *   - The SDK matches resource-template URIs literally, including query strings.
 *     Helpers register a `-query` template variant for resources that accept
 *     `?cursor`, `?limit`, or `?fields`.
 *   - Cursor template behavior in clients is uneven (Cursor's MCP impl
 *     historically doesn't surface resource templates). Tool equivalents
 *     come in later phases (run_insights is the first; see tools/insights.ts).
 */
export function registerAllResources(server: McpServer): void {
  registerAccountResources(server);
  registerCampaignResources(server);
  registerAdSetResources(server);
  registerAdResources(server);
  registerCreativeResources(server);
  registerAudienceResources(server);
  registerInsightsResources(server);
}
