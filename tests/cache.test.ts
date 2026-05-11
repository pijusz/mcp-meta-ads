import { afterEach, describe, expect, test } from "bun:test";
import {
  cacheClear,
  cached,
  cacheGet,
  cacheInvalidate,
  cacheInvalidatePrefix,
  cacheSet,
  cacheSize,
  tokenKey,
  tokenPrefix,
} from "@/services/cache";

afterEach(() => {
  cacheClear();
});

describe("cache primitives", () => {
  test("set/get round-trips a value", () => {
    cacheSet("k", { hello: "world" }, 10_000);
    expect(cacheGet<{ hello: string }>("k")).toEqual({ hello: "world" });
  });

  test("get returns undefined for missing keys", () => {
    expect(cacheGet("missing")).toBeUndefined();
  });

  test("expired entries are evicted on read", () => {
    cacheSet("k", "value", 1);
    // wait past TTL
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(cacheGet("k")).toBeUndefined();
        expect(cacheSize()).toBe(0);
        resolve();
      }, 5);
    });
  });

  test("Number.POSITIVE_INFINITY TTL never expires", () => {
    cacheSet("k", "forever", Number.POSITIVE_INFINITY);
    // Advance well past any sane TTL; entry should still be there.
    expect(cacheGet<string>("k")).toBe("forever");
  });

  test("cacheInvalidate removes a specific key", () => {
    cacheSet("a", 1, 10_000);
    cacheSet("b", 2, 10_000);
    expect(cacheInvalidate("a")).toBe(true);
    expect(cacheGet("a")).toBeUndefined();
    expect(cacheGet<number>("b")).toBe(2);
  });

  test("cacheInvalidatePrefix removes all matching keys, returns count", () => {
    cacheSet("token1:me", 1, 10_000);
    cacheSet("token1:accounts", 2, 10_000);
    cacheSet("token2:me", 3, 10_000);
    const removed = cacheInvalidatePrefix("token1:");
    expect(removed).toBe(2);
    expect(cacheGet("token1:me")).toBeUndefined();
    expect(cacheGet("token1:accounts")).toBeUndefined();
    expect(cacheGet<number>("token2:me")).toBe(3);
  });
});

describe("cached() helper", () => {
  test("computes once, returns cached on subsequent calls", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      return { count: calls };
    };
    const a = await cached("k", 10_000, fn);
    const b = await cached("k", 10_000, fn);
    const c = await cached("k", 10_000, fn);
    expect(a).toEqual({ count: 1 });
    expect(b).toEqual({ count: 1 });
    expect(c).toEqual({ count: 1 });
    expect(calls).toBe(1);
  });

  test("re-computes after expiry", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      return calls;
    };
    await cached("k", 1, fn);
    await new Promise((r) => setTimeout(r, 5));
    await cached("k", 1, fn);
    expect(calls).toBe(2);
  });
});

describe("tokenKey + tokenPrefix — never include the token verbatim", () => {
  test("tokenKey is deterministic for the same input", () => {
    expect(tokenKey("abc", "me")).toBe(tokenKey("abc", "me"));
  });

  test("tokenKey changes when the token changes", () => {
    expect(tokenKey("abc", "me")).not.toBe(tokenKey("xyz", "me"));
  });

  test("tokenKey never embeds the raw token", () => {
    const key = tokenKey("my-secret-token-aaaa", "me");
    expect(key).not.toContain("my-secret-token-aaaa");
    expect(key).not.toContain("secret");
  });

  test("tokenPrefix is the prefix of every tokenKey for the same token", () => {
    const token = "some-token";
    const prefix = tokenPrefix(token);
    expect(tokenKey(token, "me").startsWith(prefix)).toBe(true);
    expect(tokenKey(token, "accounts").startsWith(prefix)).toBe(true);
  });

  test("invalidating a token prefix removes only that token's entries", () => {
    const t1 = "token-one";
    const t2 = "token-two";
    cacheSet(tokenKey(t1, "me"), { id: "1" }, 10_000);
    cacheSet(tokenKey(t1, "adaccounts"), { data: [] }, 10_000);
    cacheSet(tokenKey(t2, "me"), { id: "2" }, 10_000);
    const removed = cacheInvalidatePrefix(tokenPrefix(t1));
    expect(removed).toBe(2);
    expect(cacheGet(tokenKey(t1, "me"))).toBeUndefined();
    expect(cacheGet<{ id: string }>(tokenKey(t2, "me"))).toEqual({ id: "2" });
  });
});
