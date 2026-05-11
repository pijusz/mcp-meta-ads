import { afterEach, describe, expect, test } from "bun:test";
import { graphFetch } from "@/services/meta-graph-api";
import {
  createRegistry,
  getTestAccountId,
  liveSkipReason,
  liveTestsEnabled,
  testName,
} from "./_helpers";

const registry = createRegistry();

afterEach(async () => {
  const { deleted, failed } = await registry.cleanup();
  if (failed > 0) console.error(`[cleanup] ${failed} entities failed to delete`);
  if (deleted > 0) console.log(`[cleanup] removed ${deleted} test entities`);
});

/**
 * Helper — creates a minimal OUTCOME_TRAFFIC campaign (the cheapest parent)
 * for an ad set test to live inside.
 */
async function createParentCampaign(): Promise<{
  actId: string;
  campaignId: string;
}> {
  const actId = getTestAccountId();
  const created = await graphFetch<{ id: string }>(`${actId}/campaigns`, {
    method: "POST",
    body: {
      name: testName("adset-parent"),
      objective: "OUTCOME_TRAFFIC",
      status: "PAUSED",
      special_ad_categories: ["NONE"],
      is_adset_budget_sharing_enabled: false,
    },
  });
  registry.trackCampaign(created.id);
  return { actId, campaignId: created.id };
}

describe.skipIf(!liveTestsEnabled())(
  `[live] ad set lifecycle (${liveSkipReason()})`,
  () => {
    test("create → read → delete", async () => {
      const { actId, campaignId } = await createParentCampaign();
      const name = testName("adset");

      const created = await graphFetch<{ id: string }>(`${actId}/adsets`, {
        method: "POST",
        body: {
          campaign_id: campaignId,
          name,
          optimization_goal: "LINK_CLICKS",
          billing_event: "IMPRESSIONS",
          status: "PAUSED",
          daily_budget: 100, // $1/day, cents
          bid_strategy: "LOWEST_COST_WITHOUT_CAP",
          targeting: {
            geo_locations: { countries: ["US"] },
            age_min: 18,
            age_max: 65,
          },
          start_time: new Date(Date.now() + 60_000).toISOString(),
        },
      });
      expect(created.id).toMatch(/^\d+$/);
      registry.trackAdSet(created.id);

      const read = await graphFetch<{
        id: string;
        name: string;
        status: string;
        campaign_id: string;
      }>(created.id, {
        params: { fields: "id,name,status,campaign_id" },
      });
      expect(read.id).toBe(created.id);
      expect(read.name).toBe(name);
      expect(read.status).toBe("PAUSED");
      expect(read.campaign_id).toBe(campaignId);

      // Delete the ad set explicitly (registry cleanup will be a no-op)
      const del = await graphFetch<{ success?: boolean }>(created.id, {
        method: "DELETE",
      });
      expect(del.success ?? true).toBe(true);
    }, 30_000);

    test("full status transitions: PAUSED → ACTIVE → PAUSED → ARCHIVED → DELETED", async () => {
      const { actId, campaignId } = await createParentCampaign();
      const name = testName("adset-status");

      const created = await graphFetch<{ id: string }>(`${actId}/adsets`, {
        method: "POST",
        body: {
          campaign_id: campaignId,
          name,
          optimization_goal: "LINK_CLICKS",
          billing_event: "IMPRESSIONS",
          status: "PAUSED",
          daily_budget: 100,
          // Sandbox accounts require an explicit bid_strategy on ad sets;
          // LOWEST_COST_WITHOUT_CAP avoids needing a bid_amount.
          bid_strategy: "LOWEST_COST_WITHOUT_CAP",
          targeting: { geo_locations: { countries: ["US"] } },
          start_time: new Date(Date.now() + 60_000).toISOString(),
        },
      });
      registry.trackAdSet(created.id);

      // PAUSED → ACTIVE
      await graphFetch(created.id, {
        method: "POST",
        body: { status: "ACTIVE" },
      });
      let snap = await graphFetch<{ status: string }>(created.id, {
        params: { fields: "status" },
      });
      expect(snap.status).toBe("ACTIVE");

      // ACTIVE → PAUSED
      await graphFetch(created.id, {
        method: "POST",
        body: { status: "PAUSED" },
      });
      snap = await graphFetch<{ status: string }>(created.id, {
        params: { fields: "status" },
      });
      expect(snap.status).toBe("PAUSED");

      // PAUSED → ARCHIVED
      await graphFetch(created.id, {
        method: "POST",
        body: { status: "ARCHIVED" },
      });
      snap = await graphFetch<{ status: string }>(created.id, {
        params: { fields: "status" },
      });
      expect(snap.status).toBe("ARCHIVED");

      // ARCHIVED → DELETED
      await graphFetch(created.id, { method: "DELETE" });
    }, 45_000); // 10+ sequential calls; ad set creation alone takes ~2s

    test("update_adset — partial updates take effect (rename + budget)", async () => {
      const { actId, campaignId } = await createParentCampaign();
      const name = testName("adset-update");

      const created = await graphFetch<{ id: string }>(`${actId}/adsets`, {
        method: "POST",
        body: {
          campaign_id: campaignId,
          name,
          optimization_goal: "LINK_CLICKS",
          billing_event: "IMPRESSIONS",
          status: "PAUSED",
          daily_budget: 100,
          // Sandbox accounts require an explicit bid_strategy on ad sets;
          // LOWEST_COST_WITHOUT_CAP avoids needing a bid_amount.
          bid_strategy: "LOWEST_COST_WITHOUT_CAP",
          targeting: { geo_locations: { countries: ["US"] } },
          start_time: new Date(Date.now() + 60_000).toISOString(),
        },
      });
      registry.trackAdSet(created.id);

      const newName = `${name}-renamed`;
      await graphFetch(created.id, {
        method: "POST",
        body: { name: newName, daily_budget: 200 },
      });

      const read = await graphFetch<{ name: string; daily_budget: string }>(created.id, {
        params: { fields: "name,daily_budget" },
      });
      expect(read.name).toBe(newName);
      expect(read.daily_budget).toBe("200");
    }, 30_000);
  },
);
