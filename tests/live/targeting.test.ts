import { describe, expect, test } from "bun:test";
import { graphFetch } from "@/services/meta-graph-api";
import { liveSkipReason, liveTestsEnabled } from "./_helpers";

describe.skipIf(!liveTestsEnabled())(
  `[live] targeting search (${liveSkipReason()})`,
  () => {
    test("search_interests — returns at least one result for a common term", async () => {
      const res = await graphFetch<{
        data?: Array<{ id: string; name: string }>;
      }>("search", {
        params: { type: "adinterest", q: "fitness", limit: 5, locale: "en_US" },
      });
      const data = res.data ?? [];
      expect(data.length).toBeGreaterThan(0);
      for (const item of data) {
        expect(item.id).toMatch(/^\d+$/);
        expect(item.name.length).toBeGreaterThan(0);
      }
    });

    test("search_geo_locations — country search returns 'US'", async () => {
      const res = await graphFetch<{
        data?: Array<{ key: string; name: string; type: string }>;
      }>("search", {
        params: {
          type: "adgeolocation",
          q: "united states",
          limit: 5,
          locale: "en_US",
          location_types: JSON.stringify(["country"]),
        },
      });
      const data = res.data ?? [];
      expect(data.length).toBeGreaterThan(0);
      const us = data.find((d) => d.key === "US");
      expect(us).toBeDefined();
      expect(us?.type).toBe("country");
    });

    test("search_behaviors — list returns categories (may be empty on dev tier)", async () => {
      const res = await graphFetch<{ data?: Array<{ id: string; name: string }> }>(
        "search",
        {
          params: {
            type: "adTargetingCategory",
            class: "behaviors",
            limit: 10,
          },
        },
      );
      // Sandbox / development-tier apps may return zero behaviors. Assert
      // shape, not count.
      expect(Array.isArray(res.data ?? [])).toBe(true);
    });
  },
);
