import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { graphFetch } from "@/services/meta-graph-api";
import { normalizeActId } from "@/utils/account-id";
import { MetaApiError } from "@/utils/errors";
import { writeTool } from "@/utils/register-tool";

/**
 * Ad set mutation tools. Part of v0.2 — same pattern as campaigns.ts.
 *
 * Targeting is passed through as raw JSON. Builder helpers (search_interests,
 * search_geo_locations, build_targeting) are decision #12 in docs/SPEC.md
 * and land in v0.3.
 */

const OPTIMIZATION_GOAL = z.enum([
  "NONE",
  "APP_INSTALLS",
  "AD_RECALL_LIFT",
  "ENGAGED_USERS",
  "EVENT_RESPONSES",
  "IMPRESSIONS",
  "LEAD_GENERATION",
  "QUALITY_LEAD",
  "LINK_CLICKS",
  "OFFSITE_CONVERSIONS",
  "PAGE_LIKES",
  "POST_ENGAGEMENT",
  "QUALITY_CALL",
  "REACH",
  "LANDING_PAGE_VIEWS",
  "VISIT_INSTAGRAM_PROFILE",
  "VALUE",
  "THRUPLAY",
  "REPLIES",
  "CONVERSATIONS",
  "MEANINGFUL_CALL_ATTEMPT",
  "PROFILE_VISIT",
  "PROFILE_AND_PAGE_ENGAGEMENT",
  "ADVERTISER_SILOED_VALUE",
  "IN_APP_VALUE",
  "AD_VIEWERSHIP",
]);

const BILLING_EVENT = z.enum([
  "APP_INSTALLS",
  "IMPRESSIONS",
  "LINK_CLICKS",
  "NONE",
  "PAGE_LIKES",
  "POST_ENGAGEMENT",
  "THRUPLAY",
  "VIDEO_VIEWS",
  "LISTING_INTERACTION",
  "MESSAGES",
  "PURCHASE",
]);

const STATUS = z.enum(["ACTIVE", "PAUSED", "ARCHIVED", "DELETED"]);

const BID_STRATEGY = z.enum([
  "LOWEST_COST_WITHOUT_CAP",
  "LOWEST_COST_WITH_BID_CAP",
  "COST_CAP",
  "LOWEST_COST_WITH_MIN_ROAS",
]);

interface AdSetCreateResponse {
  id: string;
}

interface AdSetCopyResponse {
  copied_adset_id?: string;
  ad_object_ids?: Array<Record<string, string>>;
}

export function registerAdSetTools(server: McpServer): void {
  writeTool(
    server,
    "create_adset",
    `⚠️ WRITE OPERATION — Create a new Meta ad set inside an existing campaign.

Notes:
- Status defaults to PAUSED so the ad set won't start spending until you explicitly resume.
- 'optimization_goal' must match the campaign's objective (e.g. OUTCOME_TRAFFIC campaign → LINK_CLICKS or LANDING_PAGE_VIEWS).
- 'billing_event' is what Meta charges you for: IMPRESSIONS is the safest default.
- 'targeting' is Meta's raw JSON shape — pass at minimum { geo_locations: { countries: ['US'] } }. Builder helpers ship in v0.3.
- Budget must be either at campaign level (CBO) or set here (one of daily_budget / lifetime_budget). When set here, also pass start_time and (for lifetime_budget) end_time.
- bid_amount is REQUIRED for LOWEST_COST_WITH_BID_CAP and COST_CAP strategies.`,
    {
      account_id: z.string().describe("Ad account ID, with or without 'act_' prefix."),
      campaign_id: z.string().describe("Parent campaign ID."),
      name: z.string().min(1),
      optimization_goal: OPTIMIZATION_GOAL,
      billing_event: BILLING_EVENT.default("IMPRESSIONS"),
      status: STATUS.default("PAUSED"),
      targeting: z
        .record(z.string(), z.unknown())
        .describe(
          "Meta targeting spec JSON. At minimum: { geo_locations: { countries: ['US'] } }. Add age_min/age_max, genders, interests (by ID), behaviors, etc.",
        ),
      daily_budget: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Ad-set-level daily budget in account-currency smallest unit. Use only if the campaign isn't a CBO.",
        ),
      lifetime_budget: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Lifetime budget — requires end_time."),
      bid_amount: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Bid cap (smallest unit). Required for LOWEST_COST_WITH_BID_CAP / COST_CAP.",
        ),
      bid_strategy: BID_STRATEGY.optional(),
      start_time: z
        .string()
        .optional()
        .describe("ISO 8601 — defaults to now if omitted."),
      end_time: z
        .string()
        .optional()
        .describe("ISO 8601 — required if using lifetime_budget."),
      promoted_object: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Object being promoted: e.g. { pixel_id, custom_event_type: 'PURCHASE' } for OUTCOME_SALES, or { application_id, object_store_url } for OUTCOME_APP_PROMOTION.",
        ),
      attribution_spec: z
        .array(z.record(z.string(), z.unknown()))
        .optional()
        .describe(
          "Attribution windows. Defaults to ad-set-level Ads Manager-equivalent settings (1d_click + 7d_click).",
        ),
      is_adset_budget_sharing_enabled: z
        .boolean()
        .optional()
        .describe(
          "v24+ — conditionally required by Meta when the ad set sets its own budget (non-CBO). When true, this ad set can lend up to 20% of its budget to sibling ad sets in the same campaign. Defaults to false when ad-set-level budget is set and caller didn't specify.",
        ),
      extra: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Escape hatch for fields not exposed above."),
    },
    async (args) => {
      try {
        const actId = normalizeActId(args.account_id);

        // v24+: Meta conditionally requires is_adset_budget_sharing_enabled when
        // the ad set carries its own budget (non-CBO setup). Auto-default to
        // false when caller didn't specify and an ad-set-level budget is set —
        // matches the same defensive pattern in create_campaign.
        const hasAdsetBudget =
          args.daily_budget !== undefined || args.lifetime_budget !== undefined;
        const adsetSharing =
          args.is_adset_budget_sharing_enabled ?? (hasAdsetBudget ? false : undefined);

        const body: Record<string, unknown> = {
          campaign_id: args.campaign_id,
          name: args.name,
          optimization_goal: args.optimization_goal,
          billing_event: args.billing_event,
          status: args.status,
          targeting: args.targeting,
          ...(args.daily_budget !== undefined && { daily_budget: args.daily_budget }),
          ...(args.lifetime_budget !== undefined && {
            lifetime_budget: args.lifetime_budget,
          }),
          ...(args.bid_amount !== undefined && { bid_amount: args.bid_amount }),
          ...(args.bid_strategy && { bid_strategy: args.bid_strategy }),
          ...(args.start_time && { start_time: args.start_time }),
          ...(args.end_time && { end_time: args.end_time }),
          ...(args.promoted_object && { promoted_object: args.promoted_object }),
          ...(args.attribution_spec && { attribution_spec: args.attribution_spec }),
          ...(adsetSharing !== undefined && {
            is_adset_budget_sharing_enabled: adsetSharing,
          }),
          ...(args.extra ?? {}),
        };
        const res = await graphFetch<AdSetCreateResponse>(`${actId}/adsets`, {
          method: "POST",
          body,
        });
        return success({ id: res.id, status: args.status });
      } catch (err) {
        return failure(err);
      }
    },
  );

  writeTool(
    server,
    "update_adset",
    `⚠️ WRITE OPERATION — Update fields on an existing ad set. Partial update.

If you change daily_budget or lifetime_budget on a non-CBO ad set, Meta may require is_adset_budget_sharing_enabled to be re-asserted (v24+ — see create_adset). Pass it explicitly if the update fails with subcode 4834011.`,
    {
      adset_id: z.string(),
      name: z.string().optional(),
      status: STATUS.optional(),
      daily_budget: z.number().int().positive().optional(),
      lifetime_budget: z.number().int().positive().optional(),
      bid_amount: z.number().int().nonnegative().optional(),
      bid_strategy: BID_STRATEGY.optional(),
      optimization_goal: OPTIMIZATION_GOAL.optional(),
      billing_event: BILLING_EVENT.optional(),
      targeting: z.record(z.string(), z.unknown()).optional(),
      start_time: z.string().optional(),
      end_time: z.string().optional(),
      is_adset_budget_sharing_enabled: z
        .boolean()
        .optional()
        .describe(
          "v24+ — re-assert if changing budget on a non-CBO ad set. See create_adset for full details.",
        ),
      extra: z.record(z.string(), z.unknown()).optional(),
    },
    async (args) => {
      try {
        const { adset_id, extra, ...rest } = args;
        const body = stripUndefined({ ...rest, ...(extra ?? {}) });
        if (Object.keys(body).length === 0) {
          return failure(new MetaApiError({ message: "No fields to update." }));
        }
        const res = await graphFetch<{ success: boolean }>(adset_id, {
          method: "POST",
          body,
        });
        return success({ adset_id, success: res.success ?? true });
      } catch (err) {
        return failure(err);
      }
    },
  );

  registerStatusSetter(server, {
    name: "pause_adset",
    description: "⚠️ WRITE OPERATION — Pause an ad set (status=PAUSED).",
    targetStatus: "PAUSED",
  });
  registerStatusSetter(server, {
    name: "resume_adset",
    description: "⚠️ WRITE OPERATION — Resume an ad set (status=ACTIVE).",
    targetStatus: "ACTIVE",
  });
  registerStatusSetter(server, {
    name: "archive_adset",
    description: "⚠️ WRITE OPERATION — Archive an ad set (status=ARCHIVED).",
    targetStatus: "ARCHIVED",
  });

  writeTool(
    server,
    "delete_adset",
    "⚠️ WRITE OPERATION — Soft-delete an ad set. To stop delivery without losing it, use archive_adset instead.",
    { adset_id: z.string() },
    async ({ adset_id }) => {
      try {
        const res = await graphFetch<{ success?: boolean }>(adset_id, {
          method: "DELETE",
        });
        return success({ adset_id, deleted: res.success ?? true });
      } catch (err) {
        return failure(err);
      }
    },
  );

  writeTool(
    server,
    "duplicate_adset",
    "⚠️ WRITE OPERATION — Duplicate an ad set. Calls POST /{adset_id}/copies.",
    {
      adset_id: z.string(),
      deep_copy: z.boolean().default(false).describe("If true, also copy child ads."),
      status_option: z
        .enum(["PAUSED", "ACTIVE", "INHERITED_FROM_SOURCE"])
        .default("PAUSED"),
      rename_suffix: z.string().optional(),
    },
    async (args) => {
      try {
        const body: Record<string, unknown> = {
          deep_copy: args.deep_copy,
          status_option: args.status_option,
        };
        if (args.rename_suffix) {
          body.rename_options = { rename_suffix: args.rename_suffix };
        }
        const res = await graphFetch<AdSetCopyResponse>(`${args.adset_id}/copies`, {
          method: "POST",
          body,
        });
        return success({
          source_adset_id: args.adset_id,
          copied_adset_id: res.copied_adset_id,
          ad_object_ids: res.ad_object_ids,
        });
      } catch (err) {
        return failure(err);
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
    { adset_id: z.string() },
    async ({ adset_id }) => {
      try {
        const res = await graphFetch<{ success: boolean }>(adset_id, {
          method: "POST",
          body: { status: cfg.targetStatus },
        });
        return success({
          adset_id,
          status: cfg.targetStatus,
          success: res.success ?? true,
        });
      } catch (err) {
        return failure(err);
      }
    },
  );
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function success(payload: Record<string, unknown>): {
  content: Array<{ type: "text"; text: string }>;
} {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function failure(err: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  const payload =
    err instanceof MetaApiError
      ? {
          error: {
            message: err.message,
            type: err.type,
            code: err.code,
            subcode: err.subcode,
            fbtrace_id: err.fbtraceId,
            hint: err.hint,
            status: err.status,
          },
        }
      : { error: { message: (err as Error).message ?? String(err) } };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}
