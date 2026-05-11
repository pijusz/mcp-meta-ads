import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";
import { graphFetch } from "@/services/meta-graph-api";
import { writeTool } from "@/utils/register-tool";
import { fail, ok } from "@/utils/tool-response";

/**
 * Shared mutation helpers — patterns that repeat across campaigns / ad sets /
 * ads tool files. Extracted to keep each tool file focused on its specific
 * object shape rather than re-implementing the same wrappers.
 */

/**
 * Register a tool that flips a single object to a target status via
 * `POST /{id}` with `{ status: <target> }`. Used by `pause_*` / `resume_*` /
 * `archive_*` tools across campaigns, ad sets, and ads.
 *
 * The caller supplies a Zod input schema whose only field is the object ID,
 * and tells us which key holds the ID (e.g. `campaign_id`, `adset_id`, `ad_id`).
 *
 * Example:
 *   registerStatusTool(server, {
 *     name: "pause_campaign",
 *     description: "⚠️ WRITE OPERATION — Pause a campaign (status=PAUSED).",
 *     targetStatus: "PAUSED",
 *     inputSchema: { campaign_id: z.string() },
 *     idField: "campaign_id",
 *   });
 */
export function registerStatusTool<Args extends ZodRawShape>(
  server: McpServer,
  config: {
    name: string;
    description: string;
    targetStatus: string;
    inputSchema: Args;
    idField: keyof Args & string;
  },
): void {
  // The handler type-cast is required because TypeScript can't reconcile our
  // generic Args with the SDK's ToolCallback<Args> shape from inside another
  // generic function. The cast is sound — registerTool checks the runtime
  // schema at call time, and we only read the single `idField` from args.
  const handler = async (args: Record<string, unknown>) => {
    const id = args[config.idField] as string;
    try {
      const res = await graphFetch<{ success: boolean }>(id, {
        method: "POST",
        body: { status: config.targetStatus },
      });
      return ok({
        [config.idField]: id,
        status: config.targetStatus,
        success: res.success ?? true,
      });
    } catch (err) {
      return fail(err);
    }
  };
  writeTool(
    server,
    config.name,
    config.description,
    config.inputSchema,
    handler as unknown as ToolCallback<Args>,
  );
}
