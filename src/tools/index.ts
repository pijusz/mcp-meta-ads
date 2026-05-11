import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCampaignTools } from "@/tools/campaigns";
import { registerInsightsTools } from "@/tools/insights";
import { registerRawTools } from "@/tools/raw";

/**
 * Tool registration barrel.
 *
 * Tier 4 scope per docs/SPEC.md §3 — implementations land per release (see §10).
 */
export function registerAllTools(server: McpServer): void {
  registerRawTools(server);
  registerInsightsTools(server);
  registerCampaignTools(server);
  // TODO(v0.2): registerAdSetTools(server);
  // TODO(v0.2): registerAdTools(server);
  // TODO(v0.2): registerCreativeTools(server);
  // TODO(v0.3): registerAudienceTools(server);
  // TODO(v0.3): registerTargetingTools(server);
  // TODO(v0.4): registerCapiTools(server);
  // TODO(v0.5): registerCatalogTools(server);
  // TODO(v0.6): registerEngagementTools(server);
}
