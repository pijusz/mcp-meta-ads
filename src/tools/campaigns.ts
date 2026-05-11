import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { graphFetch } from "@/services/meta-graph-api";
import { normalizeActId } from "@/utils/account-id";
import { MetaApiError } from "@/utils/errors";
import { writeTool } from "@/utils/register-tool";
import { fail, ok, stripUndefined } from "@/utils/tool-response";

/**
 * Campaign mutation tools. v0.1 of v0.2 phase.
 *
 * Per docs/SPEC.md decision #2 ("no gate"), all writes ship live whenever the
 * server has a valid token. Each tool description starts with `⚠️ WRITE OPERATION`
 * so MCP clients render a permission prompt; `writeTool` adds the appropriate
 * destructiveHint / idempotentHint annotations.
 *
 * Posture against the 2026-05-19 global Advantage+ enforcement (see
 * docs/RESEARCH.md §2.7):
 *   - We strip `smart_promotion_type` from every create body (v25 removed it),
 *     which incidentally also blocks the field that callers historically used
 *     to opt into legacy ASC / AAC creation. After 2026-05-19 those calls fail
 *     on the API anyway; before, this prevents accidental legacy structures.
 */

const OBJECTIVE = z.enum([
  "OUTCOME_AWARENESS",
  "OUTCOME_TRAFFIC",
  "OUTCOME_ENGAGEMENT",
  "OUTCOME_LEADS",
  "OUTCOME_APP_PROMOTION",
  "OUTCOME_SALES",
]);

const STATUS = z.enum(["ACTIVE", "PAUSED", "ARCHIVED", "DELETED"]);

const BID_STRATEGY = z.enum([
  "LOWEST_COST_WITHOUT_CAP",
  "LOWEST_COST_WITH_BID_CAP",
  "COST_CAP",
  "LOWEST_COST_WITH_MIN_ROAS",
]);

const BUYING_TYPE = z.enum(["AUCTION", "RESERVED"]);

const SPECIAL_AD_CATEGORY = z.enum([
  "EMPLOYMENT",
  "HOUSING",
  "CREDIT",
  "ISSUES_ELECTIONS_POLITICS",
  "ONLINE_GAMBLING_AND_GAMING",
  "FINANCIAL_PRODUCTS_SERVICES",
  "NONE",
]);

/**
 * Drop fields that Meta rejects, ignores, or that introduce legacy-ASC/AAC risk.
 * Called on every create / update body before send.
 *
 * Exported for testing. The function is pure; the test asserts each forbidden
 * field is stripped and that legitimate fields pass through unchanged.
 */
export function sanitizeCampaignBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const {
    // v25.0: removed from campaign creation. Was historically used to opt
    // into legacy ASC ("AUTOMATED_SHOPPING_ADS") and AAC ("AUTOMATED_APP_ADS"),
    // both blocked globally on 2026-05-19.
    smart_promotion_type: _smart,
    // Read-only since v23.0 — Meta returns an error if you try to write it.
    advantage_state: _adv,
    // Retracted 2025-08-27 (Special Ad Category certification rollout walked back).
    is_sac_cfca_terms_certified: _certified,
    is_eligible_for_sac_campaigns: _eligible,
    ...clean
  } = body;
  return clean;
}

interface CampaignCreateResponse {
  id: string;
}

interface CampaignUpdateResponse {
  success: boolean;
}

interface CampaignCopyResponse {
  copied_campaign_id?: string;
  ad_object_ids?: Array<Record<string, string>>;
}

export function registerCampaignTools(server: McpServer): void {
  writeTool(
    server,
    "create_campaign",
    `⚠️ WRITE OPERATION — Create a new Meta Ads campaign.

Notes:
- Status defaults to PAUSED so the campaign won't start spending until you explicitly resume.
- 'special_ad_categories' is required by Meta — defaults to ["NONE"]. Use ["HOUSING"] / ["EMPLOYMENT"] / ["CREDIT"] / ["ISSUES_ELECTIONS_POLITICS"] etc. for those regulated verticals.
- Budgets are in the account's currency, in the smallest unit (US dollars: cents; JPY: yen; etc.).
- Daily budget can swing up to +75% above the cap (Meta v24+ behavior, weekly cap still holds).
- 'smart_promotion_type' / 'advantage_state' are stripped silently (deprecated / read-only).
- For Advantage+ Sales / Advantage+ App, use the modern ODAX objective (OUTCOME_SALES / OUTCOME_APP_PROMOTION). Legacy ASC/AAC creation is blocked globally from 2026-05-19.`,
    {
      account_id: z.string().describe("Ad account ID, with or without 'act_' prefix."),
      name: z.string().min(1).describe("Campaign name."),
      objective: OBJECTIVE.describe(
        "Campaign objective (ODAX). Use modern OUTCOME_* values; legacy objectives still work but Meta is steering away.",
      ),
      status: STATUS.default("PAUSED").describe(
        "Initial status. Defaults to PAUSED for safety.",
      ),
      special_ad_categories: z
        .array(SPECIAL_AD_CATEGORY)
        .default(["NONE"])
        .describe(
          "Required by Meta. Use ['NONE'] unless the campaign falls into a regulated category.",
        ),
      daily_budget: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Daily budget in account-currency smallest unit (e.g. cents for USD)."),
      lifetime_budget: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Lifetime budget in account-currency smallest unit. Mutually exclusive with daily_budget.",
        ),
      start_time: z
        .string()
        .optional()
        .describe("ISO 8601 start time. Required if using lifetime_budget."),
      stop_time: z
        .string()
        .optional()
        .describe("ISO 8601 stop time. Required if using lifetime_budget."),
      bid_strategy: BID_STRATEGY.optional().describe(
        "Bid strategy. LOWEST_COST_WITHOUT_CAP is the most common default.",
      ),
      buying_type: BUYING_TYPE.default("AUCTION"),
      spend_cap: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Optional total spend cap (account-currency smallest unit)."),
      is_adset_budget_sharing_enabled: z
        .boolean()
        .optional()
        .describe(
          "v24+ — REQUIRED by Meta when no campaign-level budget is set (no daily_budget / lifetime_budget). When true, ad sets in this campaign can share up to 20% of their budget to optimize overall performance. Defaults to false when omitted and no campaign budget is set.",
        ),
      extra: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Escape hatch for any field not exposed above (e.g. campaign_optimization_type, promoted_object). Merged into the body after sanitization.",
        ),
    },
    async (args) => {
      try {
        const actId = normalizeActId(args.account_id);

        // v24+: Meta requires is_adset_budget_sharing_enabled (true|false) when
        // the campaign has no top-level budget. Auto-default to false when the
        // caller didn't specify it and there's no campaign budget — gives them
        // a working create without forcing every caller to know this quirk.
        const noCampaignBudget =
          args.daily_budget === undefined && args.lifetime_budget === undefined;
        const adsetSharing =
          args.is_adset_budget_sharing_enabled ?? (noCampaignBudget ? false : undefined);

        const body = sanitizeCampaignBody({
          name: args.name,
          objective: args.objective,
          status: args.status,
          special_ad_categories: args.special_ad_categories,
          daily_budget: args.daily_budget,
          lifetime_budget: args.lifetime_budget,
          start_time: args.start_time,
          stop_time: args.stop_time,
          bid_strategy: args.bid_strategy,
          buying_type: args.buying_type,
          spend_cap: args.spend_cap,
          ...(adsetSharing !== undefined
            ? { is_adset_budget_sharing_enabled: adsetSharing }
            : {}),
          ...(args.extra ?? {}),
        });
        const res = await graphFetch<CampaignCreateResponse>(`${actId}/campaigns`, {
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
    "update_campaign",
    `⚠️ WRITE OPERATION — Update fields on an existing campaign.

Partial update — only include fields you want to change. Daily-budget changes take effect immediately, but Meta's actual daily spend can swing up to +75% above the new cap (v24+ behavior) — keep that in mind if you're tightening a budget downward.`,
    {
      campaign_id: z.string().describe("Campaign ID."),
      name: z.string().optional(),
      status: STATUS.optional(),
      daily_budget: z.number().int().positive().optional(),
      lifetime_budget: z.number().int().positive().optional(),
      start_time: z.string().optional(),
      stop_time: z.string().optional(),
      bid_strategy: BID_STRATEGY.optional(),
      spend_cap: z.number().int().positive().optional(),
      special_ad_categories: z.array(SPECIAL_AD_CATEGORY).optional(),
      extra: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Escape hatch for fields not listed above."),
    },
    async (args) => {
      try {
        const { campaign_id, extra, ...rest } = args;
        const body = sanitizeCampaignBody({
          ...stripUndefined(rest),
          ...(extra ?? {}),
        });
        if (Object.keys(body).length === 0) {
          return fail(new MetaApiError({ message: "No fields to update." }));
        }
        const res = await graphFetch<CampaignUpdateResponse>(campaign_id, {
          method: "POST",
          body,
        });
        return ok({ campaign_id, success: res.success ?? true });
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerStatusSetter(server, {
    name: "pause_campaign",
    description:
      "⚠️ WRITE OPERATION — Pause a campaign (status=PAUSED). Halts delivery immediately.",
    targetStatus: "PAUSED",
  });

  registerStatusSetter(server, {
    name: "resume_campaign",
    description:
      "⚠️ WRITE OPERATION — Resume a paused campaign (status=ACTIVE). Begins delivery immediately if other settings allow.",
    targetStatus: "ACTIVE",
  });

  registerStatusSetter(server, {
    name: "archive_campaign",
    description:
      "⚠️ WRITE OPERATION — Archive a campaign (status=ARCHIVED). Cannot be edited further but stays visible for reporting.",
    targetStatus: "ARCHIVED",
  });

  writeTool(
    server,
    "delete_campaign",
    `⚠️ WRITE OPERATION — Soft-delete a campaign. Meta's API marks the object as DELETED; it still appears in some reports for ~6 months but cannot be edited or resumed. To stop spend without losing the object, use archive_campaign instead.`,
    {
      campaign_id: z.string().describe("Campaign ID to delete."),
    },
    async ({ campaign_id }) => {
      try {
        const res = await graphFetch<{ success?: boolean }>(campaign_id, {
          method: "DELETE",
        });
        return ok({ campaign_id, deleted: res.success ?? true });
      } catch (err) {
        return fail(err);
      }
    },
  );

  writeTool(
    server,
    "duplicate_campaign",
    `⚠️ WRITE OPERATION — Duplicate an existing campaign. Calls POST /{campaign_id}/copies.

By default, only the campaign object is copied; pass deep_copy=true to also copy its ad sets and ads. The copied campaign defaults to PAUSED for safety.`,
    {
      campaign_id: z.string().describe("Source campaign ID."),
      deep_copy: z
        .boolean()
        .default(false)
        .describe("If true, also copy child ad sets and ads."),
      status_option: z
        .enum(["PAUSED", "ACTIVE", "INHERITED_FROM_SOURCE_CAMPAIGN"])
        .default("PAUSED")
        .describe(
          "Status of the copied campaign. PAUSED is safest; INHERITED preserves source status.",
        ),
      rename_suffix: z
        .string()
        .optional()
        .describe(
          "Suffix appended to the source campaign name (Meta default: ' - Copy').",
        ),
      start_time: z.string().optional(),
      end_time: z.string().optional(),
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
        if (args.start_time) body.start_time = args.start_time;
        if (args.end_time) body.end_time = args.end_time;
        const res = await graphFetch<CampaignCopyResponse>(`${args.campaign_id}/copies`, {
          method: "POST",
          body,
        });
        return ok({
          source_campaign_id: args.campaign_id,
          copied_campaign_id: res.copied_campaign_id,
          ad_object_ids: res.ad_object_ids,
        });
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
    {
      campaign_id: z.string().describe("Campaign ID."),
    },
    async ({ campaign_id }) => {
      try {
        const res = await graphFetch<CampaignUpdateResponse>(campaign_id, {
          method: "POST",
          body: { status: cfg.targetStatus },
        });
        return ok({
          campaign_id,
          status: cfg.targetStatus,
          success: res.success ?? true,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );
}
