import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerListResource, registerSingleResource } from "./_helpers.js";

const LIST_FIELDS = [
  "id",
  "name",
  "status",
  "effective_status",
  "objective",
  "daily_budget",
  "lifetime_budget",
  "start_time",
  "stop_time",
].join(",");

const SINGLE_FIELDS = [
  "id",
  "name",
  "status",
  "effective_status",
  "objective",
  "buying_type",
  "bid_strategy",
  "daily_budget",
  "lifetime_budget",
  "budget_remaining",
  "start_time",
  "stop_time",
  "special_ad_categories",
  "special_ad_category_country",
  "created_time",
  "updated_time",
].join(",");

export function registerCampaignResources(server: McpServer): void {
  registerListResource(server, {
    name: "campaigns",
    uriTemplate: "meta-ads://act_{accountId}/campaigns",
    edge: "campaigns",
    defaultFields: LIST_FIELDS,
    title: "Ad account campaigns",
    description:
      "Campaigns under an ad account. Supports ?cursor, ?limit, ?fields. Returns { data, next_cursor? }.",
    priority: 0.9,
  });

  registerSingleResource(server, {
    name: "campaign",
    uriTemplate: "meta-ads://act_{accountId}/campaigns/{campaignId}",
    idVar: "campaignId",
    defaultFields: SINGLE_FIELDS,
    title: "Single campaign",
    description: "Campaign details by ID. Supports ?fields override.",
    priority: 0.8,
  });
}
