import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { graphFetch } from "@/services/meta-graph-api";
import { normalizeActId } from "@/utils/account-id";
import { MetaApiError } from "@/utils/errors";
import { writeTool } from "@/utils/register-tool";
import { fail, ok, stripUndefined } from "@/utils/tool-response";

/**
 * Ad mutation tools. Part of v0.2.
 *
 * Ads reference a creative by ID; create_creative lives in tools/creatives.ts.
 * The Graph API also supports inline creative specs on ad create — we expose
 * that via the `creative` field accepting either { creative_id } or a full
 * object_story_spec.
 */

const STATUS = z.enum(["ACTIVE", "PAUSED", "ARCHIVED", "DELETED"]);

interface AdCreateResponse {
  id: string;
}

export function registerAdTools(server: McpServer): void {
  writeTool(
    server,
    "create_ad",
    `⚠️ WRITE OPERATION — Create a new ad inside an existing ad set.

Notes:
- Status defaults to PAUSED.
- 'creative' is either { creative_id: 'CREATIVE_ID' } referencing an existing creative, or an inline creative spec — see Meta's adcreative reference.
- For most uses: build the creative first with create_creative, then pass { creative_id } here.`,
    {
      account_id: z.string().describe("Ad account ID, with or without 'act_' prefix."),
      adset_id: z.string().describe("Parent ad set ID."),
      name: z.string().min(1),
      creative: z
        .record(z.string(), z.unknown())
        .describe(
          "Creative reference or inline spec. Most common: { creative_id: 'XXX' }.",
        ),
      status: STATUS.default("PAUSED"),
      tracking_specs: z
        .array(z.record(z.string(), z.unknown()))
        .optional()
        .describe("Tracking specs for conversion tracking. Optional."),
      conversion_specs: z
        .array(z.record(z.string(), z.unknown()))
        .optional()
        .describe("Conversion specs. Optional."),
      extra: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Escape hatch for fields not exposed above."),
    },
    async (args) => {
      try {
        const actId = normalizeActId(args.account_id);
        const body: Record<string, unknown> = {
          adset_id: args.adset_id,
          name: args.name,
          creative: args.creative,
          status: args.status,
          ...(args.tracking_specs && { tracking_specs: args.tracking_specs }),
          ...(args.conversion_specs && { conversion_specs: args.conversion_specs }),
          ...(args.extra ?? {}),
        };
        const res = await graphFetch<AdCreateResponse>(`${actId}/ads`, {
          method: "POST",
          body,
        });
        return ok({ id: res.id, status: args.status });
      } catch (err) {
        return fail(err);
      }
    },
  );

  writeTool(
    server,
    "update_ad",
    "⚠️ WRITE OPERATION — Update fields on an existing ad. Partial update.",
    {
      ad_id: z.string(),
      name: z.string().optional(),
      status: STATUS.optional(),
      creative: z.record(z.string(), z.unknown()).optional(),
      tracking_specs: z.array(z.record(z.string(), z.unknown())).optional(),
      conversion_specs: z.array(z.record(z.string(), z.unknown())).optional(),
      extra: z.record(z.string(), z.unknown()).optional(),
    },
    async (args) => {
      try {
        const { ad_id, extra, ...rest } = args;
        const body = stripUndefined({ ...rest, ...(extra ?? {}) });
        if (Object.keys(body).length === 0) {
          return fail(new MetaApiError({ message: "No fields to update." }));
        }
        const res = await graphFetch<{ success: boolean }>(ad_id, {
          method: "POST",
          body,
        });
        return ok({ ad_id, success: res.success ?? true });
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerStatusSetter(server, {
    name: "pause_ad",
    description: "⚠️ WRITE OPERATION — Pause an ad (status=PAUSED).",
    targetStatus: "PAUSED",
  });
  registerStatusSetter(server, {
    name: "resume_ad",
    description: "⚠️ WRITE OPERATION — Resume an ad (status=ACTIVE).",
    targetStatus: "ACTIVE",
  });
  registerStatusSetter(server, {
    name: "archive_ad",
    description: "⚠️ WRITE OPERATION — Archive an ad (status=ARCHIVED).",
    targetStatus: "ARCHIVED",
  });

  writeTool(
    server,
    "delete_ad",
    "⚠️ WRITE OPERATION — Soft-delete an ad. To stop delivery without losing the object, use archive_ad instead.",
    { ad_id: z.string() },
    async ({ ad_id }) => {
      try {
        const res = await graphFetch<{ success?: boolean }>(ad_id, {
          method: "DELETE",
        });
        return ok({ ad_id, deleted: res.success ?? true });
      } catch (err) {
        return fail(err);
      }
    },
  );
}

function registerStatusSetter(
  server: McpServer,
  cfg: { name: string; description: string; targetStatus: string },
): void {
  writeTool(
    server,
    cfg.name,
    cfg.description,
    { ad_id: z.string() },
    async ({ ad_id }) => {
      try {
        const res = await graphFetch<{ success: boolean }>(ad_id, {
          method: "POST",
          body: { status: cfg.targetStatus },
        });
        return ok({ ad_id, status: cfg.targetStatus, success: res.success ?? true });
      } catch (err) {
        return fail(err);
      }
    },
  );
}
