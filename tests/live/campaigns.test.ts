import { afterEach, describe, expect, test } from "bun:test";
import { graphFetch } from "@/services/meta-graph-api";
import { MetaApiError } from "@/utils/errors";
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
  if (failed > 0) {
    console.error(`[cleanup] ${failed} entities failed to delete`);
  }
  if (deleted > 0) {
    console.log(`[cleanup] removed ${deleted} test entities`);
  }
});

describe.skipIf(!liveTestsEnabled())(
  `[live] campaign lifecycle (${liveSkipReason()})`,
  () => {
    test("create → read → delete", async () => {
      const actId = getTestAccountId();
      const name = testName("crud");

      // Create — defaults to PAUSED, no budget, no schedule. Smallest legal payload.
      const created = await graphFetch<{ id: string }>(`${actId}/campaigns`, {
        method: "POST",
        body: {
          name,
          objective: "OUTCOME_TRAFFIC",
          status: "PAUSED",
          special_ad_categories: ["NONE"],
          // v24+ requires this when there's no campaign-level budget; matches
          // what create_campaign auto-defaults.
          is_adset_budget_sharing_enabled: false,
        },
      });
      expect(created.id).toMatch(/^\d+$/);
      registry.trackCampaign(created.id);

      // Read back
      const read = await graphFetch<{ id: string; name: string; status: string }>(
        created.id,
        { params: { fields: "id,name,status,objective" } },
      );
      expect(read.id).toBe(created.id);
      expect(read.name).toBe(name);
      expect(read.status).toBe("PAUSED");

      // Delete (registry cleanup will be a no-op for this one)
      const del = await graphFetch<{ success?: boolean }>(created.id, {
        method: "DELETE",
      });
      expect(del.success ?? true).toBe(true);

      // Verify deletion — Meta soft-deletes: GET still returns the campaign
      // with status=DELETED (not a 100:33). Some objects 404 on subsequent
      // reads, but campaigns specifically stay queryable for reporting.
      let postDeleteState: { status?: string } | null = null;
      try {
        postDeleteState = await graphFetch<{ status: string }>(created.id, {
          params: { fields: "status" },
        });
      } catch (err) {
        // If Meta did 404 with 100:33, treat that as deleted too.
        if (err instanceof MetaApiError && err.code === 100 && err.subcode === 33) {
          postDeleteState = { status: "DELETED" };
        } else {
          throw err;
        }
      }
      expect(postDeleteState?.status).toBe("DELETED");
    }, 30_000);

    test("full status transitions: PAUSED → ACTIVE → PAUSED → ARCHIVED → DELETED", async () => {
      const actId = getTestAccountId();
      const name = testName("status");

      const created = await graphFetch<{ id: string }>(`${actId}/campaigns`, {
        method: "POST",
        body: {
          name,
          objective: "OUTCOME_TRAFFIC",
          status: "PAUSED",
          special_ad_categories: ["NONE"],
          // v24+ requires this when there's no campaign-level budget; matches
          // what create_campaign auto-defaults.
          is_adset_budget_sharing_enabled: false,
        },
      });
      registry.trackCampaign(created.id);

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

      // ARCHIVED → DELETED (soft-delete via DELETE method, not status patch)
      await graphFetch(created.id, { method: "DELETE" });
    }, 30_000); // ~8 sequential API calls; default 5s timeout is too tight

    test("update_campaign — partial updates take effect", async () => {
      const actId = getTestAccountId();
      const name = testName("update");

      const created = await graphFetch<{ id: string }>(`${actId}/campaigns`, {
        method: "POST",
        body: {
          name,
          objective: "OUTCOME_TRAFFIC",
          status: "PAUSED",
          special_ad_categories: ["NONE"],
          // v24+ requires this when there's no campaign-level budget; matches
          // what create_campaign auto-defaults.
          is_adset_budget_sharing_enabled: false,
        },
      });
      registry.trackCampaign(created.id);

      const newName = `${name}-renamed`;
      await graphFetch(created.id, {
        method: "POST",
        body: { name: newName },
      });

      const read = await graphFetch<{ name: string }>(created.id, {
        params: { fields: "name" },
      });
      expect(read.name).toBe(newName);
    }, 30_000);

    // Note: the sanitizer (smart_promotion_type / advantage_state stripping)
    // is unit-tested in `tests/campaigns.test.ts` — it's a pure function and
    // doesn't need to round-trip through the live API to be verified.
  },
);
