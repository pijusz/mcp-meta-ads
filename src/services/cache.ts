import { createHash } from "node:crypto";

/**
 * In-memory cache primitives for hot-path Meta API responses.
 *
 * Scope: per-process. Lost on server restart. Disk-backed caching across
 * restarts is intentionally out of scope for v1.0 — Meta API calls at startup
 * are 1 call per boot, not a real burden, and disk caching adds path /
 * eviction / corruption-recovery complexity that's not worth it yet.
 *
 * Keying convention: every cache key starts with `sha256(token).slice(0,12)`
 * so token rotation invalidates everything tied to the old token. The token
 * itself never appears in keys (avoids leaking via heap dumps / debugger).
 *
 * Per SPEC.md §16.
 */

interface Entry<T> {
  value: T;
  expiresAt: number; // ms epoch; Number.POSITIVE_INFINITY = process-lifetime
}

const cache = new Map<string, Entry<unknown>>();

export function tokenKey(token: string, suffix: string): string {
  const prefix = createHash("sha256").update(token).digest("hex").slice(0, 12);
  return `${prefix}:${suffix}`;
}

/**
 * Get a cached value if present and not expired.
 */
export function cacheGet<T>(key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value as T;
}

/**
 * Store a value with a TTL in ms. `ttlMs = Number.POSITIVE_INFINITY` caches for
 * the process lifetime (memoize-forever semantics).
 */
export function cacheSet<T>(key: string, value: T, ttlMs: number): void {
  cache.set(key, {
    value,
    expiresAt:
      ttlMs === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : Date.now() + ttlMs,
  });
}

/**
 * Invalidate one key. Returns true if something was removed.
 */
export function cacheInvalidate(key: string): boolean {
  return cache.delete(key);
}

/**
 * Invalidate every key starting with a given prefix.
 * Used when a token-scoped event (auth failure, explicit rotation) should
 * blow away all derived caches for that token.
 */
export function cacheInvalidatePrefix(prefix: string): number {
  let removed = 0;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
      removed++;
    }
  }
  return removed;
}

/**
 * Compute a value if not cached, otherwise return the cached one.
 * `ttlMs = Number.POSITIVE_INFINITY` for memoize-forever.
 */
export async function cached<T>(
  key: string,
  ttlMs: number,
  compute: () => Promise<T>,
): Promise<T> {
  const hit = cacheGet<T>(key);
  if (hit !== undefined) return hit;
  const value = await compute();
  cacheSet(key, value, ttlMs);
  return value;
}

/**
 * Clear the entire cache. Test-only utility.
 */
export function cacheClear(): void {
  cache.clear();
}

/**
 * Inspect cache size. Test-only utility.
 */
export function cacheSize(): number {
  return cache.size;
}

/**
 * Compute a key prefix for "everything tied to this token". Used by
 * graphFetch on 401/403 to nuke all derived caches via cacheInvalidatePrefix().
 */
export function tokenPrefix(token: string): string {
  return `${createHash("sha256").update(token).digest("hex").slice(0, 12)}:`;
}
