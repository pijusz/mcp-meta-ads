import { getAppSecretProof, getAuthHeaders } from "../auth/index.js";
import { getEnv } from "../config/env.js";
import { MetaApiError, parseGraphError } from "../utils/errors.js";
import { log } from "../utils/logger.js";

const BASE = "https://graph.facebook.com";

export interface GraphRequestOptions {
  method?: "GET" | "POST" | "DELETE";
  params?: Record<string, string | number | boolean | string[] | undefined>;
  body?: Record<string, unknown>;
  // Override default fetch timeout (ms)
  timeout?: number;
  // Override default retry count
  retries?: number;
}

interface UsageHeader {
  call_count?: number;
  total_cputime?: number;
  total_time?: number;
}

interface BusinessUsageHeader {
  [accountId: string]: UsageHeader[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildUrl(path: string, params?: GraphRequestOptions["params"]): string {
  const env = getEnv();
  // Path may or may not include a version prefix; normalize.
  const cleanedPath = path.replace(/^\/+/, "");
  const hasVersion = /^v\d+\.\d+\//.test(cleanedPath);
  const versioned = hasVersion
    ? cleanedPath
    : `${env.META_GRAPH_API_VERSION}/${cleanedPath}`;
  const url = new URL(`${BASE}/${versioned}`);

  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        url.searchParams.set(key, value.join(","));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }

  // Append appsecret_proof if app secret is configured.
  const proof = getAppSecretProof();
  if (proof) {
    url.searchParams.set("appsecret_proof", proof);
  }

  return url.toString();
}

function parseUsageHeader<T>(headerValue: string | null): T | null {
  if (!headerValue) return null;
  try {
    return JSON.parse(headerValue) as T;
  } catch {
    return null;
  }
}

function maxUsagePercent(usage: UsageHeader | UsageHeader[] | undefined | null): number {
  if (!usage) return 0;
  const list = Array.isArray(usage) ? usage : [usage];
  let max = 0;
  for (const u of list) {
    max = Math.max(max, u.call_count ?? 0, u.total_cputime ?? 0, u.total_time ?? 0);
  }
  return max;
}

/**
 * Inspect rate-limit headers; if any counter exceeds the threshold,
 * insert a jittered sleep to slow down the next call.
 */
async function maybeProactiveBackoff(headers: Headers): Promise<void> {
  const env = getEnv();
  const threshold = env.META_ADS_RATE_LIMIT_THRESHOLD;

  const appUsage = parseUsageHeader<UsageHeader>(headers.get("x-app-usage"));
  const adAccountUsage = parseUsageHeader<UsageHeader>(headers.get("x-ad-account-usage"));
  const businessUsage = parseUsageHeader<BusinessUsageHeader>(
    headers.get("x-business-use-case-usage"),
  );

  let max = Math.max(maxUsagePercent(appUsage), maxUsagePercent(adAccountUsage));
  if (businessUsage) {
    for (const list of Object.values(businessUsage)) {
      max = Math.max(max, maxUsagePercent(list));
    }
  }

  if (max >= threshold) {
    // Scale sleep by how far over the threshold we are.
    const overage = max - threshold;
    const ms = 250 + overage * 50 + Math.floor(Math.random() * 250);
    log.warn(`Meta usage at ${max}% — proactive backoff ${ms}ms`);
    await sleep(ms);
  }
}

// Throttle / transient codes worth retrying. Includes Business Use Case
// rate limit codes (80000–80004) — see docs/RESEARCH.md §2.3.
// Note: 1487504 ("insights query too large") is intentionally NOT retried —
// it's a signal to fall back to async insights, handled in services/insights.ts.
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 32, 613, 80000, 80001, 80002, 80004]);
const RETRYABLE_SUBCODES = new Set([2446079]);

function shouldRetry(status: number, err?: MetaApiError): boolean {
  if (status === 429 || status >= 500) return true;
  if (err?.code != null && RETRYABLE_CODES.has(err.code)) return true;
  if (err?.subcode != null && RETRYABLE_SUBCODES.has(err.subcode)) return true;
  return false;
}

/**
 * Central Graph API fetch with retries + rate-limit awareness.
 *
 * - Adds Authorization + appsecret_proof.
 * - Parses error envelope into a typed MetaApiError on failure.
 * - Retries on 429 / 5xx / code 1,2,4,17,32,613 with exponential backoff + jitter.
 * - Reads X-App-Usage / X-Ad-Account-Usage / X-Business-Use-Case-Usage; backs off proactively.
 */
export async function graphFetch<T>(
  path: string,
  opts: GraphRequestOptions = {},
): Promise<T> {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch is unavailable. Use Node 18+ or Bun.");
  }

  const { method = "GET", params, body, timeout = 30_000, retries = 3 } = opts;

  const url = buildUrl(path, params);
  const headers = getAuthHeaders();
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  let lastError: MetaApiError | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);

      await maybeProactiveBackoff(res.headers);

      if (res.ok) {
        // Some Graph endpoints respond with text (e.g. video upload status).
        const ct = res.headers.get("content-type") ?? "";
        if (ct.includes("application/json")) {
          return (await res.json()) as T;
        }
        return (await res.text()) as unknown as T;
      }

      let bodyJson: unknown = null;
      try {
        bodyJson = await res.json();
      } catch {
        bodyJson = await res.text().catch(() => null);
      }

      const err = parseGraphError(res.status, bodyJson);
      lastError = err;

      if (attempt < retries && shouldRetry(res.status, err)) {
        const delay = 1000 * 2 ** attempt + Math.floor(Math.random() * 500);
        log.warn(
          `Meta API ${res.status} code=${err.code ?? "-"} subcode=${err.subcode ?? "-"} — retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`,
        );
        await sleep(delay);
        continue;
      }

      throw err;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof MetaApiError) {
        if (attempt < retries && shouldRetry(err.status ?? 0, err)) {
          const delay = 1000 * 2 ** attempt + Math.floor(Math.random() * 500);
          await sleep(delay);
          continue;
        }
        throw err;
      }
      // Network / abort / unknown error.
      const reason = (err as Error).message ?? String(err);
      if (attempt < retries) {
        const delay = 1000 * 2 ** attempt + Math.floor(Math.random() * 500);
        log.warn(
          `Fetch error — retrying in ${delay}ms (attempt ${attempt + 1}/${retries}): ${reason}`,
        );
        await sleep(delay);
        continue;
      }
      throw new MetaApiError({ message: `Network error: ${reason}` });
    }
  }

  throw lastError ?? new MetaApiError({ message: "Graph API request failed" });
}

/**
 * Single-page fetch for a list endpoint.
 * Returns { data, next_cursor? } so the caller can pass cursor on the next call.
 *
 * Pagination posture (see docs/SPEC.md decision 13): one page at a time.
 * The caller decides whether to follow `next_cursor`.
 */
export async function graphPaginate<T>(
  path: string,
  opts: GraphRequestOptions = {},
): Promise<{ data: T[]; next_cursor?: string }> {
  const env = getEnv();
  const params = { ...(opts.params ?? {}) };
  // Spec §5.2 contract: callers pass `?cursor=<after_cursor>`. Meta's Graph API
  // expects the param to be named `after`. Translate at the boundary so the
  // public URI surface matches the spec and the wire call works.
  if (params.cursor !== undefined && params.after === undefined) {
    params.after = params.cursor;
  }
  delete params.cursor;
  if (params.limit === undefined) {
    params.limit = env.META_ADS_DEFAULT_PAGE_SIZE;
  }
  type Page = { data?: T[]; paging?: { cursors?: { after?: string }; next?: string } };
  const page = await graphFetch<Page>(path, { ...opts, params });
  const nextCursor = page.paging?.next ? page.paging.cursors?.after : undefined;
  return {
    data: page.data ?? [],
    ...(nextCursor ? { next_cursor: nextCursor } : {}),
  };
}

/**
 * Probe `GET /me` to validate the access token. Called at startup if
 * META_ADS_VALIDATE_AT_STARTUP=true.
 */
export async function validateToken(): Promise<{ id: string; name?: string }> {
  return graphFetch<{ id: string; name?: string }>("me", {
    params: { fields: "id,name" },
  });
}
