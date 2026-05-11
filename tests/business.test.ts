import { afterEach, describe, expect, test } from "bun:test";
import { fetchBmEdges } from "@/tools/business";

interface Captured {
  url: string;
}

process.env.META_ADS_ENV_FILE = "/tmp/mcp-meta-ads-test-no-such-file.env";
process.env.META_ADS_ACCESS_TOKEN = "test-token";
process.env.META_ADS_APP_SECRET = "";

const originalFetch = globalThis.fetch;

function stubFetch(responder: (url: string) => unknown): {
  captured: Captured[];
  restore: () => void;
} {
  const captured: Captured[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    captured.push({ url });
    const body = responder(url);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return {
    captured,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchBmEdges — owned/client edge composition", () => {
  test("OWNED only calls /owned_X, not /client_X", async () => {
    const { captured } = stubFetch(() => ({ data: [{ id: "act_1" }] }));
    const out = await fetchBmEdges<{ id: string }>(
      "biz_999",
      "ad_accounts",
      "OWNED",
      "id",
      50,
    );
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toContain("/biz_999/owned_ad_accounts");
    expect(out.map((r) => r.id)).toEqual(["act_1"]);
  });

  test("CLIENT only calls /client_X, not /owned_X", async () => {
    const { captured } = stubFetch(() => ({ data: [{ id: "act_2" }] }));
    const out = await fetchBmEdges<{ id: string }>(
      "biz_999",
      "pages",
      "CLIENT",
      "id",
      50,
    );
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toContain("/biz_999/client_pages");
    expect(out.map((r) => r.id)).toEqual(["act_2"]);
  });

  test("BOTH calls both edges and dedupes IDs that appear in both", async () => {
    const { captured } = stubFetch((url) => {
      if (url.includes("/owned_")) return { data: [{ id: "act_A" }, { id: "act_B" }] };
      if (url.includes("/client_")) return { data: [{ id: "act_B" }, { id: "act_C" }] };
      return { data: [] };
    });
    const out = await fetchBmEdges<{ id: string }>(
      "biz_999",
      "ad_accounts",
      "BOTH",
      "id",
      50,
    );
    expect(captured).toHaveLength(2);
    expect(out.map((r) => r.id).sort()).toEqual(["act_A", "act_B", "act_C"]);
  });

  test("pixels edge name is composed correctly", async () => {
    const { captured } = stubFetch(() => ({ data: [] }));
    await fetchBmEdges<{ id: string }>("biz_999", "pixels", "OWNED", "id", 50);
    expect(captured[0].url).toContain("/biz_999/owned_pixels");
  });
});
