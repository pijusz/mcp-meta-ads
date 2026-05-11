import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerListResource, registerSingleResource } from "@/resources/_helpers";

const LIST_FIELDS = [
  "id",
  "name",
  "description",
  "subtype",
  "approximate_count_lower_bound",
  "approximate_count_upper_bound",
  "delivery_status",
  "operation_status",
  "data_source",
].join(",");

const SINGLE_FIELDS = [
  "id",
  "name",
  "description",
  "subtype",
  "approximate_count_lower_bound",
  "approximate_count_upper_bound",
  "delivery_status",
  "operation_status",
  "data_source",
  "lookalike_spec",
  "rule",
  "retention_days",
  "time_created",
  "time_updated",
].join(",");

export function registerAudienceResources(server: McpServer): void {
  registerListResource(server, {
    name: "audiences",
    uriTemplate: "meta-ads://act_{accountId}/audiences",
    edge: "customaudiences",
    defaultFields: LIST_FIELDS,
    title: "Custom audiences",
    description:
      "Custom audiences under an ad account (customer files, website traffic, lookalikes). Read-only.",
    priority: 0.7,
  });

  registerSingleResource(server, {
    name: "audience",
    uriTemplate: "meta-ads://act_{accountId}/audiences/{audienceId}",
    idVar: "audienceId",
    defaultFields: SINGLE_FIELDS,
    title: "Single custom audience",
    description: "Audience details by ID, including subtype and lookalike spec.",
    priority: 0.6,
  });
}
