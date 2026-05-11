import { afterEach, describe, expect, test } from "bun:test";

// Set required env BEFORE importing the modules that read it at load time.
process.env.META_ADS_ACCESS_TOKEN = "test-token";
process.env.META_GRAPH_API_VERSION = "v23.0";

const { graphPaginate } = await import("../src/services/meta-graph-api.js");

interface Captured {
  url: string;
  init?: RequestInit;
}

const originalFetch = globalThis.fetch;

function stubFetch(responder: (url: string, init?: RequestInit) => Response): Captured[] {
  const captured: Captured[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    captured.push({ url, init });
    return responder(url, init);
  };
  return captured;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("graphPaginate", () => {
  test("translates `cursor` param to Meta's `after` on the wire (P1 regression)", async () => {
    const captured = stubFetch(() =>
      jsonResponse({
        data: [{ id: "1" }],
        paging: { cursors: { after: "NEXT" }, next: "https://..." },
      }),
    );

    await graphPaginate("act_123/campaigns", {
      params: { cursor: "ABC123", limit: 50 },
    });

    expect(captured).toHaveLength(1);
    const wireUrl = new URL(captured[0]!.url);
    expect(wireUrl.searchParams.get("after")).toBe("ABC123");
    expect(wireUrl.searchParams.get("cursor")).toBeNull();
    expect(wireUrl.searchParams.get("limit")).toBe("50");
  });

  test("does not overwrite a caller-supplied `after` with `cursor`", async () => {
    const captured = stubFetch(() => jsonResponse({ data: [] }));

    await graphPaginate("act_123/campaigns", {
      params: { cursor: "FROM_CURSOR", after: "FROM_AFTER" },
    });

    const wireUrl = new URL(captured[0]!.url);
    expect(wireUrl.searchParams.get("after")).toBe("FROM_AFTER");
    expect(wireUrl.searchParams.get("cursor")).toBeNull();
  });

  test("applies env default page size when `limit` is omitted", async () => {
    const captured = stubFetch(() => jsonResponse({ data: [] }));

    await graphPaginate("act_123/campaigns", { params: { fields: "id" } });

    const wireUrl = new URL(captured[0]!.url);
    expect(wireUrl.searchParams.get("limit")).toBe("25"); // META_ADS_DEFAULT_PAGE_SIZE default
    expect(wireUrl.searchParams.get("fields")).toBe("id");
  });

  test("returns next_cursor only when `paging.next` is present", async () => {
    stubFetch(() =>
      jsonResponse({
        data: [{ id: "1" }, { id: "2" }],
        paging: { cursors: { after: "LATER" } /* no next URL → last page */ },
      }),
    );

    const result = await graphPaginate<{ id: string }>("act_123/campaigns", {});
    expect(result.data.map((d) => d.id)).toEqual(["1", "2"]);
    expect(result.next_cursor).toBeUndefined();
  });

  test("returns next_cursor when paging.next exists", async () => {
    stubFetch(() =>
      jsonResponse({
        data: [{ id: "1" }],
        paging: { cursors: { after: "GOON" }, next: "https://graph.facebook.com/..." },
      }),
    );

    const result = await graphPaginate<{ id: string }>("act_123/campaigns", {});
    expect(result.next_cursor).toBe("GOON");
  });
});

describe("graphFetch URL construction", () => {
  test("prepends configured API version when path omits it", async () => {
    const captured = stubFetch(() => jsonResponse({ data: [] }));
    await graphPaginate("act_123/campaigns", {});
    expect(captured[0]!.url).toContain("/v23.0/act_123/campaigns");
  });

  test("respects an explicit version prefix in path", async () => {
    const captured = stubFetch(() => jsonResponse({ data: [] }));
    await graphPaginate("v22.0/act_123/campaigns", {});
    expect(captured[0]!.url).toContain("/v22.0/act_123/campaigns");
    expect(captured[0]!.url).not.toContain("/v23.0/v22.0/");
  });
});
