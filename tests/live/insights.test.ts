import { describe, expect, test } from "bun:test";
import { runInsights } from "@/services/insights";
import { getTestAccountId, liveSkipReason, liveTestsEnabled } from "./_helpers";

describe.skipIf(!liveTestsEnabled())(`[live] insights (${liveSkipReason()})`, () => {
  test("sync read returns rows shape — last_7d, campaign level", async () => {
    const actId = getTestAccountId();
    const result = await runInsights(actId, {
      level: "account",
      fields: ["impressions", "clicks", "spend"],
      date_preset: "last_7d",
    });
    // The account might genuinely have no spend in the last 7d — that's fine.
    // We assert the shape, not the values.
    expect(result.mode).toBe("sync");
    expect(Array.isArray(result.data)).toBe(true);
    for (const row of result.data) {
      // At least one of the requested fields should be present.
      const hasField = "impressions" in row || "clicks" in row || "spend" in row;
      expect(hasField).toBe(true);
    }
  });

  test("campaign-level breakdown by age survives the auto-fixer", async () => {
    const actId = getTestAccountId();
    const result = await runInsights(actId, {
      level: "campaign",
      fields: ["impressions", "clicks"],
      breakdowns: ["age"],
      date_preset: "last_7d",
    });
    // Even with no impressions, the call should not throw; data may be empty.
    expect(result.mode).toBe("sync");
    expect(Array.isArray(result.data)).toBe(true);
  });

  test("compact mode does not strip non-omni actions", async () => {
    // Run twice — once with compact, once without — and assert any action_type
    // that doesn't start with omni_ / offsite_ is present in both.
    const actId = getTestAccountId();
    const base = {
      level: "account" as const,
      fields: ["impressions", "actions"],
      date_preset: "last_30d",
    };
    const full = await runInsights(actId, { ...base, compact: false });
    const slim = await runInsights(actId, { ...base, compact: true });

    // Find a row in full that has actions; verify the corresponding compact row.
    const fullActions =
      (full.data[0]?.actions as Array<{ action_type: string }> | undefined) ?? [];
    const slimActions =
      (slim.data[0]?.actions as Array<{ action_type: string }> | undefined) ?? [];
    const nonOmni = fullActions.filter(
      (a) => !a.action_type.startsWith("omni_") && !a.action_type.startsWith("offsite_"),
    );
    for (const a of nonOmni) {
      const stillThere = slimActions.find((b) => b.action_type === a.action_type);
      expect(stillThere).toBeDefined();
    }
    // And: nothing in slim should start with omni_ or offsite_.
    for (const a of slimActions) {
      expect(
        a.action_type.startsWith("omni_") || a.action_type.startsWith("offsite_"),
      ).toBe(false);
    }
  });
});
