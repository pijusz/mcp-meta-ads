import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAccountResources } from "@/resources/accounts";
import { registerAdResources } from "@/resources/ads";
import { registerAdSetResources } from "@/resources/adsets";
import { registerAudienceResources } from "@/resources/audiences";
import { registerCampaignResources } from "@/resources/campaigns";
import { registerCreativeResources } from "@/resources/creatives";
import { registerInsightsResources } from "@/resources/insights";
import { registerPixelResources } from "@/resources/pixels";

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
  registerPixelResources(server);
}
