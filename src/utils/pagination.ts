/**
 * Pagination + query-param helpers used by resources and tools that wrap a
 * Graph API list endpoint.
 */

/**
 * Parse a `limit` query param. Returns `undefined` for missing input (caller
 * decides the default); throws on non-numeric or out-of-range input.
 *
 * Meta accepts limit up to 100 for most list endpoints; we don't enforce that
 * here since some endpoints (insights drain, etc.) accept larger.
 */
export function parseLimit(raw: string | null | undefined): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`Invalid limit: ${raw}`);
  }
  return n;
}

/**
 * Extract `cursor` (paginate-forward) and `limit` from a URL's searchParams.
 * Returns only the keys that were actually provided so they can be spread
 * into a graphPaginate params object without overwriting defaults with
 * `undefined`.
 */
export function paginationParams(searchParams: URLSearchParams): {
  cursor?: string;
  limit?: number;
} {
  const out: { cursor?: string; limit?: number } = {};
  const cursor = searchParams.get("cursor");
  if (cursor) out.cursor = cursor;
  const limit = parseLimit(searchParams.get("limit"));
  if (limit !== undefined) out.limit = limit;
  return out;
}
