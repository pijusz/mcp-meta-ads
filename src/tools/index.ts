import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAdTools } from "@/tools/ads";
import { registerAdSetTools } from "@/tools/adsets";
import { registerAudienceTools } from "@/tools/audiences";
import { registerCampaignTools } from "@/tools/campaigns";
import { registerCapiTools } from "@/tools/capi";
import { registerCreativeTools } from "@/tools/creatives";
import { registerInsightsTools } from "@/tools/insights";
import { registerRawTools } from "@/tools/raw";
import { registerTargetingTools } from "@/tools/targeting";

/**
 * Tool registration barrel.
 *
 * Tier 4 scope per docs/SPEC.md §3 — implementations land per release (see §10).
 */
export function registerAllTools(server: McpServer): void {
  registerRawTools(server);
  registerInsightsTools(server);
  registerCampaignTools(server);
  registerAdSetTools(server);
  registerAdTools(server);
  registerCreativeTools(server);
  registerAudienceTools(server);
  registerTargetingTools(server);
  registerCapiTools(server);
  // TODO(v0.5): registerCatalogTools(server);
  // TODO(v0.6): registerEngagementTools(server);
}
