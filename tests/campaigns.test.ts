import { describe, expect, test } from "bun:test";
import { sanitizeCampaignBody } from "@/tools/campaigns";

describe("sanitizeCampaignBody", () => {
  test("strips smart_promotion_type (v25 removed; legacy ASC/AAC opt-in)", () => {
    const out = sanitizeCampaignBody({
      name: "x",
      objective: "OUTCOME_SALES",
      smart_promotion_type: "AUTOMATED_SHOPPING_ADS",
    });
    expect(out).not.toHaveProperty("smart_promotion_type");
    expect(out.objective).toBe("OUTCOME_SALES");
    expect(out.name).toBe("x");
  });

  test("strips advantage_state (read-only since v23)", () => {
    const out = sanitizeCampaignBody({
      name: "x",
      advantage_state: "ON",
    });
    expect(out).not.toHaveProperty("advantage_state");
    expect(out.name).toBe("x");
  });

  test("strips retracted SAC certification fields (2025-08-27 rollback)", () => {
    const out = sanitizeCampaignBody({
      name: "x",
      is_sac_cfca_terms_certified: true,
      is_eligible_for_sac_campaigns: false,
    });
    expect(out).not.toHaveProperty("is_sac_cfca_terms_certified");
    expect(out).not.toHaveProperty("is_eligible_for_sac_campaigns");
  });

  test("strips all forbidden fields in one body", () => {
    const out = sanitizeCampaignBody({
      name: "x",
      objective: "OUTCOME_SALES",
      smart_promotion_type: "AUTOMATED_SHOPPING_ADS",
      advantage_state: "ON",
      is_sac_cfca_terms_certified: true,
      is_eligible_for_sac_campaigns: false,
    });
    expect(Object.keys(out).sort()).toEqual(["name", "objective"]);
  });

  test("preserves legitimate fields unchanged", () => {
    const body = {
      name: "Test Campaign",
      objective: "OUTCOME_TRAFFIC",
      status: "PAUSED",
      special_ad_categories: ["NONE"],
      daily_budget: 1000,
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      buying_type: "AUCTION",
      spend_cap: 50000,
      start_time: "2026-06-01T00:00:00+0000",
      stop_time: "2026-06-30T23:59:59+0000",
    };
    const out = sanitizeCampaignBody(body);
    expect(out).toEqual(body);
  });

  test("returns a new object — does not mutate input", () => {
    const input = {
      name: "x",
      smart_promotion_type: "AUTOMATED_SHOPPING_ADS",
    };
    sanitizeCampaignBody(input);
    // Input must still contain the field — we don't mutate the caller's object.
    expect(input).toHaveProperty("smart_promotion_type");
  });

  test("empty body passes through cleanly", () => {
    expect(sanitizeCampaignBody({})).toEqual({});
  });

  test("body with only forbidden fields returns empty object", () => {
    const out = sanitizeCampaignBody({
      smart_promotion_type: "AUTOMATED_APP_ADS",
      advantage_state: "ON",
    });
    expect(out).toEqual({});
  });
});
