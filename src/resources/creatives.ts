import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerListResource, registerSingleResource } from "@/resources/_helpers";

const LIST_FIELDS = [
  "id",
  "name",
  "status",
  "title",
  "body",
  "image_hash",
  "video_id",
  "thumbnail_url",
  "object_type",
  "call_to_action_type",
].join(",");

const SINGLE_FIELDS = [
  "id",
  "name",
  "status",
  "title",
  "body",
  "image_hash",
  "image_url",
  "video_id",
  "thumbnail_url",
  "object_story_spec",
  "asset_feed_spec",
  "object_type",
  "call_to_action_type",
  "link_url",
  "url_tags",
].join(",");

export function registerCreativeResources(server: McpServer): void {
  registerListResource(server, {
    name: "creatives",
    uriTemplate: "meta-ads://act_{accountId}/creatives",
    edge: "adcreatives",
    defaultFields: LIST_FIELDS,
    title: "Ad account creatives",
    description: "Ad creatives under an ad account. Supports ?cursor, ?limit, ?fields.",
    priority: 0.7,
  });

  registerSingleResource(server, {
    name: "creative",
    uriTemplate: "meta-ads://act_{accountId}/creatives/{creativeId}",
    idVar: "creativeId",
    defaultFields: SINGLE_FIELDS,
    title: "Single ad creative",
    description: "Creative details by ID, including full object_story_spec.",
    priority: 0.6,
  });
}
