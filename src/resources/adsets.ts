import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerListResource, registerSingleResource } from "./_helpers.js";

const LIST_FIELDS = [
  "id",
  "name",
  "campaign_id",
  "status",
  "effective_status",
  "optimization_goal",
  "billing_event",
  "daily_budget",
  "lifetime_budget",
  "start_time",
  "end_time",
].join(",");

const SINGLE_FIELDS = [
  "id",
  "name",
  "campaign_id",
  "status",
  "effective_status",
  "optimization_goal",
  "billing_event",
  "bid_strategy",
  "bid_amount",
  "daily_budget",
  "lifetime_budget",
  "budget_remaining",
  "targeting",
  "promoted_object",
  "attribution_spec",
  "start_time",
  "end_time",
  "created_time",
  "updated_time",
].join(",");

export function registerAdSetResources(server: McpServer): void {
  registerListResource(server, {
    name: "adsets",
    uriTemplate: "meta-ads://act_{accountId}/adsets",
    edge: "adsets",
    defaultFields: LIST_FIELDS,
    title: "Ad account ad sets",
    description:
      "Ad sets under an ad account. Supports ?cursor, ?limit, ?fields. Returns { data, next_cursor? }.",
    priority: 0.9,
  });

  registerSingleResource(server, {
    name: "adset",
    uriTemplate: "meta-ads://act_{accountId}/adsets/{adsetId}",
    idVar: "adsetId",
    defaultFields: SINGLE_FIELDS,
    title: "Single ad set",
    description: "Ad set details by ID, including full targeting spec.",
    priority: 0.8,
  });
}
