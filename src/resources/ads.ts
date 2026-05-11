import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerListResource, registerSingleResource } from "@/resources/_helpers";

const LIST_FIELDS = [
  "id",
  "name",
  "adset_id",
  "campaign_id",
  "status",
  "effective_status",
  "created_time",
  "updated_time",
].join(",");

const SINGLE_FIELDS = [
  "id",
  "name",
  "adset_id",
  "campaign_id",
  "creative",
  "status",
  "effective_status",
  "tracking_specs",
  "conversion_specs",
  "issues_info",
  "created_time",
  "updated_time",
].join(",");

export function registerAdResources(server: McpServer): void {
  registerListResource(server, {
    name: "ads",
    uriTemplate: "meta-ads://act_{accountId}/ads",
    edge: "ads",
    defaultFields: LIST_FIELDS,
    title: "Ad account ads",
    description:
      "Ads under an ad account. Supports ?cursor, ?limit, ?fields. Returns { data, next_cursor? }.",
    priority: 0.85,
  });

  registerSingleResource(server, {
    name: "ad",
    uriTemplate: "meta-ads://act_{accountId}/ads/{adId}",
    idVar: "adId",
    defaultFields: SINGLE_FIELDS,
    title: "Single ad",
    description: "Ad details by ID, including creative reference + issues.",
    priority: 0.8,
  });
}
