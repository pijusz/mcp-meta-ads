import { afterEach, describe, expect, test } from "bun:test";
import { graphFetch } from "@/services/meta-graph-api";
import { hashRow } from "@/services/pii";
import {
  createRegistry,
  getTestAccountId,
  liveBusinessAttachedSkipReason,
  liveBusinessAttachedTestsEnabled,
  testName,
} from "./_helpers";

const registry = createRegistry();

afterEach(async () => {
  const { deleted, failed } = await registry.cleanup();
  if (failed > 0) console.error(`[cleanup] ${failed} entities failed to delete`);
  if (deleted > 0) console.log(`[cleanup] removed ${deleted} test entities`);
});

describe.skipIf(!liveBusinessAttachedTestsEnabled())(
  `[live] custom audience lifecycle (${liveBusinessAttachedSkipReason()})`,
  () => {
    test("create custom audience → add users → delete", async () => {
      const actId = getTestAccountId();
      const name = testName("audience");

      // 1. Create the audience shell
      const created = await graphFetch<{ id: string }>(`${actId}/customaudiences`, {
        method: "POST",
        body: {
          name,
          subtype: "CUSTOM",
          description: "MCP integration test — auto-deleted on cleanup",
          customer_file_source: "USER_PROVIDED_ONLY",
        },
      });
      expect(created.id).toMatch(/^\d+$/);
      registry.trackAudience(created.id);

      // 2. Add fake test users (never real PII; we generate values that
      //    hash deterministically but match no real person).
      const schema = ["EMAIL"];
      const testEmails = [
        "mcp-test-user-1@example.invalid",
        "mcp-test-user-2@example.invalid",
        "mcp-test-user-3@example.invalid",
      ];
      const hashed = testEmails.map((email) => hashRow(schema, [email]));
      const addRes = await graphFetch<{
        num_received?: number;
        num_invalid_entries?: number;
        session_id?: number;
      }>(`${created.id}/users`, {
        method: "POST",
        body: {
          payload: { schema, data: hashed },
          session: {
            session_id: Date.now(),
            batch_seq: 1,
            last_batch_flag: true,
            estimated_num_total: testEmails.length,
          },
        },
      });
      // Meta returns num_received counting valid rows.
      // The actual audience size update is async (can take minutes to
      // reflect in `approximate_count_*`) — we just assert receipt here.
      expect(typeof addRes.num_received).toBe("number");
      expect(addRes.num_received).toBe(testEmails.length);
      expect(addRes.num_invalid_entries ?? 0).toBe(0);

      // 3. Delete (registry cleanup will be a no-op for this one)
      const del = await graphFetch<{ success?: boolean }>(created.id, {
        method: "DELETE",
      });
      expect(del.success ?? true).toBe(true);
    }, 30_000);

    test("audience update — rename takes effect", async () => {
      const actId = getTestAccountId();
      const name = testName("audience-update");

      const created = await graphFetch<{ id: string }>(`${actId}/customaudiences`, {
        method: "POST",
        body: {
          name,
          subtype: "CUSTOM",
          customer_file_source: "USER_PROVIDED_ONLY",
        },
      });
      registry.trackAudience(created.id);

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
  },
);
