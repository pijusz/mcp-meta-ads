import { afterAll, describe, expect, test } from "bun:test";
import { graphFetch, validateToken } from "@/services/meta-graph-api";
import { getTestAccountId, liveSkipReason, liveTestsEnabled } from "./_helpers";

describe.skipIf(!liveTestsEnabled())(
  `[live] auth + account reads (${liveSkipReason()})`,
  () => {
    test("GET /me returns a valid user identity", async () => {
      const me = await validateToken();
      expect(me.id).toMatch(/^\d+$/);
      if (me.name) expect(me.name.length).toBeGreaterThan(0);
    });

    test("GET /me/adaccounts returns at least the test account", async () => {
      const res = await graphFetch<{
        data?: Array<{ id: string; account_id?: string; name?: string }>;
      }>("me/adaccounts", {
        params: { fields: "id,account_id,name", limit: 100 },
      });
      const accounts = res.data ?? [];
      expect(accounts.length).toBeGreaterThan(0);
      const testAccountId = getTestAccountId();
      const found = accounts.find((a) => a.id === testAccountId);
      expect(found).toBeDefined();
    });

    test("GET /act_X returns account details for the configured test account", async () => {
      const testAccountId = getTestAccountId();
      const account = await graphFetch<{
        id: string;
        account_status?: number;
        currency?: string;
      }>(testAccountId, {
        params: { fields: "id,account_status,currency,timezone_name" },
      });
      expect(account.id).toBe(testAccountId);
      expect(account.currency).toMatch(/^[A-Z]{3}$/);
    });

    afterAll(() => {
      // Auth tests don't create anything; nothing to clean up.
    });
  },
);
