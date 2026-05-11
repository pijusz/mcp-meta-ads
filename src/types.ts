/**
 * Shared types for mcp-meta-ads.
 *
 * Only the most commonly used Graph API enums are typed here; specific tools
 * carry their own narrower types alongside the Zod schemas.
 */

export type CampaignObjective =
  | "OUTCOME_AWARENESS"
  | "OUTCOME_TRAFFIC"
  | "OUTCOME_ENGAGEMENT"
  | "OUTCOME_LEADS"
  | "OUTCOME_APP_PROMOTION"
  | "OUTCOME_SALES";

export type EffectiveStatus =
  | "ACTIVE"
  | "PAUSED"
  | "DELETED"
  | "PENDING_REVIEW"
  | "DISAPPROVED"
  | "PREAPPROVED"
  | "PENDING_BILLING_INFO"
  | "CAMPAIGN_PAUSED"
  | "ARCHIVED"
  | "ADSET_PAUSED"
  | "IN_PROCESS"
  | "WITH_ISSUES";

export type ConfiguredStatus = "ACTIVE" | "PAUSED" | "ARCHIVED" | "DELETED";

export type BillingEvent =
  | "IMPRESSIONS"
  | "LINK_CLICKS"
  | "POST_ENGAGEMENT"
  | "PAGE_LIKES"
  | "VIDEO_VIEWS"
  | "APP_INSTALLS"
  | "OFFER_CLAIMS"
  | "THRUPLAY";

export type OptimizationGoal =
  | "REACH"
  | "IMPRESSIONS"
  | "LINK_CLICKS"
  | "POST_ENGAGEMENT"
  | "PAGE_LIKES"
  | "VIDEO_VIEWS"
  | "LANDING_PAGE_VIEWS"
  | "LEAD_GENERATION"
  | "QUALITY_LEAD"
  | "APP_INSTALLS"
  | "OFFSITE_CONVERSIONS"
  | "VALUE"
  | "THRUPLAY"
  | "AD_RECALL_LIFT"
  | "REPLIES";

export type BidStrategy =
  | "LOWEST_COST_WITHOUT_CAP"
  | "LOWEST_COST_WITH_BID_CAP"
  | "COST_CAP"
  | "LOWEST_COST_WITH_MIN_ROAS";

export type SpecialAdCategory =
  | "EMPLOYMENT"
  | "HOUSING"
  | "CREDIT"
  | "ISSUES_ELECTIONS_POLITICS"
  | "ONLINE_GAMBLING_AND_GAMING"
  | "NONE";

export type InsightsLevel = "account" | "campaign" | "adset" | "ad";

export type DatePreset =
  | "today"
  | "yesterday"
  | "this_month"
  | "last_month"
  | "this_quarter"
  | "maximum"
  | "data_maximum"
  | "last_3d"
  | "last_7d"
  | "last_14d"
  | "last_28d"
  | "last_30d"
  | "last_90d"
  | "last_week_mon_sun"
  | "last_week_sun_sat"
  | "last_quarter"
  | "last_year"
  | "this_week_mon_today"
  | "this_week_sun_today"
  | "this_year";

export interface PaginatedResult<T> {
  data: T[];
  next_cursor?: string;
}
