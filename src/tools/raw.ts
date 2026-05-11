import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { graphFetch } from "@/services/meta-graph-api";
import { readTool, writeTool } from "@/utils/register-tool";
import { fail } from "@/utils/tool-response";

/**
 * Escape-hatch tools for any Graph API path not covered by the higher-level
 * surface yet. They take a path (with or without a leading version) and
 * return the JSON response as text.
 *
 * Examples:
 *   raw_graph_get("me")
 *   raw_graph_get("me/adaccounts", { fields: "id,name,account_status,currency" })
 *   raw_graph_get("act_123456/campaigns", { fields: "id,name,status", limit: 50 })
 */
export function registerRawTools(server: McpServer): void {
  readTool(
    server,
    "raw_graph_get",
    `GET any Meta Graph API path. Useful for endpoints not yet wrapped by higher-level tools.
The path may omit the version prefix (e.g. "me/adaccounts" — the configured version is added).
Pass query params via the \`params\` object; array values are joined with commas.`,
    {
      path: z
        .string()
        .min(1)
        .describe(
          "Graph API path, e.g. 'me', 'me/adaccounts', 'act_123/campaigns', 'act_123/insights'.",
        ),
      params: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe(
          "Query params. Common: fields (comma-separated), limit, after, time_range, date_preset, level, breakdowns.",
        ),
    },
    async ({ path, params }) => {
      try {
        const data = await graphFetch<unknown>(path, { method: "GET", params });
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (err) {
        return fail(err);
      }
    },
  );

  writeTool(
    server,
    "raw_graph_post",
    `⚠️ WRITE OPERATION — POST to any Meta Graph API path. Creates, updates, or triggers actions.
Use only when you know the exact endpoint shape; mistakes can mutate live accounts.`,
    {
      path: z
        .string()
        .min(1)
        .describe(
          "Graph API path, e.g. 'act_123/campaigns', '<campaign_id>', 'act_123/customaudiences'.",
        ),
      params: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe("Optional query params."),
      body: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Request body (JSON). For most write endpoints this is required."),
    },
    async ({ path, params, body }) => {
      try {
        const data = await graphFetch<unknown>(path, {
          method: "POST",
          params,
          body,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (err) {
        return fail(err);
      }
    },
  );

  writeTool(
    server,
    "raw_graph_delete",
    `⚠️ WRITE OPERATION — DELETE a Meta Graph object by ID. Some objects "archive" instead of true delete; consult Meta docs per object type.`,
    {
      path: z.string().min(1).describe("Object ID or path, e.g. '<campaign_id>'."),
      params: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional(),
    },
    async ({ path, params }) => {
      try {
        const data = await graphFetch<unknown>(path, { method: "DELETE", params });
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (err) {
        return fail(err);
      }
    },
  );
}
