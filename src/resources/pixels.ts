import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerListResource, registerSingleResource } from "@/resources/_helpers";

const LIST_FIELDS = [
  "id",
  "name",
  "code",
  "creation_time",
  "last_fired_time",
  "data_use_setting",
  "is_unavailable",
].join(",");

const SINGLE_FIELDS = [
  "id",
  "name",
  "code",
  "creation_time",
  "last_fired_time",
  "data_use_setting",
  "automatic_matching_fields",
  "enable_automatic_matching",
  "first_party_cookie_status",
  "is_unavailable",
  "owner_ad_account",
  "owner_business",
].join(",");

export function registerPixelResources(server: McpServer): void {
  registerListResource(server, {
    name: "pixels",
    uriTemplate: "meta-ads://act_{accountId}/adspixels",
    edge: "adspixels",
    defaultFields: LIST_FIELDS,
    title: "Meta Pixels on an ad account",
    description:
      "Pixels associated with an ad account. Pass the pixel `id` into CAPI tools (send_conversion_events, read_pixel_events) or into adset promoted_object.",
    priority: 0.75,
  });

  registerSingleResource(server, {
    name: "pixel",
    uriTemplate: "meta-ads://act_{accountId}/adspixels/{pixelId}",
    idVar: "pixelId",
    defaultFields: SINGLE_FIELDS,
    title: "Single Meta Pixel",
    description: "Pixel details by ID, including data-use settings and ownership.",
    priority: 0.6,
  });
}
