import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { graphFetch } from "@/services/meta-graph-api";
import { normalizeActId } from "@/utils/account-id";
import { MetaApiError } from "@/utils/errors";
import { registerStatusTool } from "@/utils/mutations";
import { writeTool } from "@/utils/register-tool";
import { fail, ok, stripUndefined } from "@/utils/tool-response";

/**
 * Ad set mutation tools. Same pattern as campaigns.ts.
 *
 * Targeting is passed through as raw JSON. Builder helpers
 * (`search_interests`, `search_geo_locations`, `build_targeting`) live in
 * `src/tools/targeting.ts` — call those to assemble the targeting object.
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
  // Present in the v26 Business SDK spec (AdSet_optimization_goal).
  "APP_INSTALLS_AND_OFFSITE_CONVERSIONS",
  "AUTOMATIC_OBJECTIVE",
  "DERIVED_EVENTS",
  "ENGAGED_PAGE_VIEWS",
  "MESSAGING_APPOINTMENT_CONVERSION",
  "MESSAGING_DEEP_CONVERSATION_AND_FOLLOW",
  "MESSAGING_PURCHASE_CONVERSION",
  "REMINDERS_SET",
  "SUBSCRIBERS",
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
  "CLICKS",
  "OFFER_CLAIMS",
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

/**
 * Merge an explicit Advantage+ audience flag into a targeting spec without
 * dropping other targeting_automation keys. Exported for testing.
 */
export function withAdvantageAudience(
  targeting: Record<string, unknown>,
  advantageAudience: 0 | 1 | undefined,
): Record<string, unknown> {
  if (advantageAudience === undefined) return targeting;
  const existing = targeting.targeting_automation;
  const automation =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  return {
    ...targeting,
    targeting_automation: { ...automation, advantage_audience: advantageAudience },
  };
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
- 'targeting' is Meta's raw JSON shape — pass at minimum { geo_locations: { countries: ['US'] } }. Use the 'build_targeting' tool to assemble it from human concepts.
- Budget must be either at campaign level (CBO) or set here (one of daily_budget / lifetime_budget). When set here, also pass start_time and (for lifetime_budget) end_time.
- bid_amount is REQUIRED for LOWEST_COST_WITH_BID_CAP and COST_CAP strategies.
- Housing / Employment / Financial-products (special_ad_categories) ad sets with constrained targeting (custom audiences, detailed targeting) must set advantage_audience to 1 or 0 explicitly (v26+, all versions from 2026-10-27), or Meta returns ADS_TARGETING__REQUIRE_EXPLICIT_ADVANTAGE_AUDIENCE_FLAG.
- Removed placements (v26): Instagram Explore feed ('explore' in instagram_positions) is rejected; Messenger Stories ('story' in messenger_positions) is dropped. Leave positions unset (Advantage+ placements) or omit those values.`,
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
      advantage_audience: z
        .union([z.literal(0), z.literal(1)])
        .optional()
        .describe(
          "Sets targeting.targeting_automation.advantage_audience (1 = Advantage+ audience on, 0 = off). Required explicitly for HEC/financial ad sets with constrained targeting since v26.",
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
          targeting: withAdvantageAudience(args.targeting, args.advantage_audience),
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
        return ok({ id: res.id, status: args.status });
      } catch (err) {
        return fail(err);
      }
    },
  );

  writeTool(
    server,
    "update_adset",
    `⚠️ WRITE OPERATION — Update fields on an existing ad set. Partial update.

If you change daily_budget or lifetime_budget on a non-CBO ad set, Meta may require is_adset_budget_sharing_enabled to be re-asserted (v24+ — see create_adset). Pass it explicitly if the update fails with subcode 4834011.

When replacing targeting, the same v26 rules as create_adset apply (explicit advantage_audience for HEC/financial ad sets; no Instagram Explore / Messenger Stories positions). advantage_audience is merged into the targeting you pass, so pass targeting along with it.`,
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
      advantage_audience: z
        .union([z.literal(0), z.literal(1)])
        .optional()
        .describe(
          "Sets targeting.targeting_automation.advantage_audience. Requires `targeting` (Meta replaces the whole targeting spec).",
        ),
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
        const { adset_id, extra, advantage_audience, ...rest } = args;
        if (advantage_audience !== undefined && !rest.targeting) {
          return fail(
            new MetaApiError({
              message:
                "advantage_audience needs `targeting` too: Meta replaces the whole targeting spec on update, so pass the full targeting object.",
            }),
          );
        }
        const body = stripUndefined({
          ...rest,
          ...(rest.targeting && {
            targeting: withAdvantageAudience(rest.targeting, advantage_audience),
          }),
          ...(extra ?? {}),
        });
        if (Object.keys(body).length === 0) {
          return fail(new MetaApiError({ message: "No fields to update." }));
        }
        const res = await graphFetch<{ success: boolean }>(adset_id, {
          method: "POST",
          body,
        });
        return ok({ adset_id, success: res.success ?? true });
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerStatusTool(server, {
    name: "pause_adset",
    description: "⚠️ WRITE OPERATION — Pause an ad set (status=PAUSED).",
    targetStatus: "PAUSED",
    inputSchema: { adset_id: z.string() },
    idField: "adset_id",
  });
  registerStatusTool(server, {
    name: "resume_adset",
    description: "⚠️ WRITE OPERATION — Resume an ad set (status=ACTIVE).",
    targetStatus: "ACTIVE",
    inputSchema: { adset_id: z.string() },
    idField: "adset_id",
  });
  registerStatusTool(server, {
    name: "archive_adset",
    description: "⚠️ WRITE OPERATION — Archive an ad set (status=ARCHIVED).",
    targetStatus: "ARCHIVED",
    inputSchema: { adset_id: z.string() },
    idField: "adset_id",
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
        return ok({ adset_id, deleted: res.success ?? true });
      } catch (err) {
        return fail(err);
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
        return ok({
          source_adset_id: args.adset_id,
          copied_adset_id: res.copied_adset_id,
          ad_object_ids: res.ad_object_ids,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );
}
