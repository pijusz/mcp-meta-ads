import { getEnv } from "../config/env.js";
import { MetaApiError } from "../utils/errors.js";
import { log } from "../utils/logger.js";
import { graphFetch } from "./meta-graph-api.js";

/**
 * Insights runner with auto-async fallback.
 *
 * 1. Tries the sync `GET /act_X/insights` path.
 * 2. If Meta says "too much data" (subcode 1487504, or the message
 *    explicitly asks for async), transparently POSTs an async report
 *    job and polls to completion.
 * 3. Returns the full result set (paginates internally on async).
 *
 * Pollers honour `META_ADS_INSIGHTS_ASYNC_TIMEOUT_MS` and
 * `META_ADS_INSIGHTS_ASYNC_POLL_MS` from env.
 */

export type InsightsLevel = "account" | "campaign" | "adset" | "ad";

export interface InsightsTimeRange {
  since: string; // YYYY-MM-DD
  until: string;
}

export interface InsightsQuery {
  level?: InsightsLevel;
  fields?: string[];
  breakdowns?: string[];
  action_breakdowns?: string[];
  time_range?: InsightsTimeRange;
  date_preset?: string;
  time_increment?: string | number;
  /**
   * Default `["1d_click","7d_click"]`. 7d-view / 28d-view were removed
   * by Meta in Jan 2026 (docs/RESEARCH.md §2.7).
   */
  action_attribution_windows?: string[];
  filtering?: Array<Record<string, unknown>>;
  limit?: number;
  /**
   * If true, strip duplicate `omni_*` entries from `actions[]` rows
   * (saves ~60% of tokens — see docs/RESEARCH.md §3 / pipeboard).
   */
  compact?: boolean;
}

export type InsightsRow = Record<string, unknown>;

/**
 * Fields the LLM should never have to specify but Meta requires us to send.
 */
const DEFAULT_FIELDS = ["impressions", "clicks", "spend", "actions"];

const TERMINAL_FAILED = new Set(["Job Failed", "Job Skipped"]);
const MAX_POLL_MS = 15_000;

/**
 * Some breakdowns are mutually incompatible or require specific
 * companion fields. We "auto-fix" the most common mistakes the LLM
 * makes so users don't get cryptic API errors (docs/RESEARCH.md §3).
 */
function applyBreakdownFixes(query: InsightsQuery): InsightsQuery {
  const fixed: InsightsQuery = { ...query };
  const breakdowns = new Set(fixed.breakdowns ?? []);

  // `platform_position` requires `publisher_platform`.
  if (breakdowns.has("platform_position")) {
    breakdowns.add("publisher_platform");
  }
  // `media_type` is incompatible with action breakdowns.
  if (breakdowns.has("media_type") && fixed.action_breakdowns?.length) {
    log.debug("media_type breakdown — clearing action_breakdowns");
    fixed.action_breakdowns = undefined;
  }

  fixed.breakdowns = breakdowns.size > 0 ? Array.from(breakdowns) : undefined;
  return fixed;
}

/**
 * Strip `omni_*` duplicates from each row's `actions` array.
 * Meta returns both the platform-specific entry (`onsite_conversion.purchase`)
 * and the `omni_purchase` aggregate; for ads management the platform-specific
 * one is what the user cares about.
 */
function compactRows(rows: InsightsRow[]): InsightsRow[] {
  return rows.map((row) => {
    const out: InsightsRow = {};
    for (const [k, v] of Object.entries(row)) {
      if (Array.isArray(v) && (k === "actions" || k.endsWith("_actions"))) {
        out[k] = v.filter(
          (a: unknown) =>
            !(
              typeof a === "object" &&
              a !== null &&
              "action_type" in a &&
              typeof (a as { action_type: unknown }).action_type === "string" &&
              ((a as { action_type: string }).action_type.startsWith("omni_") ||
                (a as { action_type: string }).action_type.startsWith("offsite_"))
            ),
        );
      } else {
        out[k] = v;
      }
    }
    return out;
  });
}

function serializeQuery(
  query: InsightsQuery,
): Record<string, string | number | undefined> {
  const params: Record<string, string | number | undefined> = {};
  params.level = query.level ?? "campaign";
  const fields = (query.fields ?? DEFAULT_FIELDS).join(",");
  params.fields = fields;
  if (query.breakdowns?.length) params.breakdowns = query.breakdowns.join(",");
  if (query.action_breakdowns?.length) {
    params.action_breakdowns = query.action_breakdowns.join(",");
  }
  if (query.time_range) {
    params.time_range = JSON.stringify(query.time_range);
  }
  if (query.date_preset) params.date_preset = query.date_preset;
  if (query.time_increment !== undefined) {
    params.time_increment = String(query.time_increment);
  }
  // Default to 1d_click + 7d_click — view windows were removed Jan 2026.
  const windows = query.action_attribution_windows ?? ["1d_click", "7d_click"];
  if (windows.length) params.action_attribution_windows = JSON.stringify(windows);
  if (query.filtering?.length) params.filtering = JSON.stringify(query.filtering);
  if (query.limit !== undefined) params.limit = query.limit;
  return params;
}

function shouldFallbackToAsync(err: unknown): boolean {
  if (!(err instanceof MetaApiError)) return false;
  if (err.subcode === 1487504) return true;
  const msg = err.message ?? "";
  if (/reduce\s+the\s+amount\s+of\s+data/i.test(msg)) return true;
  if (/please\s+query\s+asynchronously/i.test(msg)) return true;
  if (/please\s+(reduce|narrow)/i.test(msg)) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface SyncPage {
  data?: InsightsRow[];
  paging?: { cursors?: { after?: string }; next?: string };
}

/**
 * Run insights. Auto-falls back to async when Meta requests it.
 * Returns the full result set (paginated internally for async).
 */
export async function runInsights(
  actId: string,
  rawQuery: InsightsQuery,
): Promise<{ data: InsightsRow[]; mode: "sync" | "async"; report_run_id?: string }> {
  const query = applyBreakdownFixes(rawQuery);
  const params = serializeQuery(query);

  // 1. Try sync.
  try {
    const page = await graphFetch<SyncPage>(`${actId}/insights`, { params });
    const data = page.data ?? [];
    return { data: query.compact ? compactRows(data) : data, mode: "sync" };
  } catch (err) {
    if (!shouldFallbackToAsync(err)) throw err;
    log.info(`Insights query too large for sync — falling back to async`);
  }

  // 2. Async: start job.
  const start = await graphFetch<{ report_run_id: string }>(`${actId}/insights`, {
    method: "POST",
    body: params as Record<string, unknown>,
  });
  const reportRunId = start.report_run_id;
  if (!reportRunId) {
    throw new MetaApiError({
      message: "Async insights job did not return report_run_id",
    });
  }

  // 3. Poll.
  await pollAsyncJob(reportRunId);

  // 4. Drain pages.
  const data = await drainAsyncResults(reportRunId, query.limit);

  return {
    data: query.compact ? compactRows(data) : data,
    mode: "async",
    report_run_id: reportRunId,
  };
}

async function pollAsyncJob(reportRunId: string): Promise<void> {
  const env = getEnv();
  const startTime = Date.now();
  let interval = env.META_ADS_INSIGHTS_ASYNC_POLL_MS;

  while (Date.now() - startTime < env.META_ADS_INSIGHTS_ASYNC_TIMEOUT_MS) {
    await sleep(interval);
    const status = await graphFetch<{
      async_status: string;
      async_percent_completion?: number;
    }>(reportRunId, {
      params: { fields: "async_status,async_percent_completion" },
    });

    if (status.async_status === "Job Completed") {
      return;
    }
    if (TERMINAL_FAILED.has(status.async_status)) {
      throw new MetaApiError({
        message: `Async insights job ${status.async_status} (report_run_id=${reportRunId})`,
      });
    }
    log.debug(
      `Insights ${reportRunId}: ${status.async_status} ${status.async_percent_completion ?? "?"}%`,
    );
    interval = Math.min(Math.floor(interval * 1.5), MAX_POLL_MS);
  }

  throw new MetaApiError({
    message: `Async insights timeout after ${env.META_ADS_INSIGHTS_ASYNC_TIMEOUT_MS}ms — resume with get_insights_job(${reportRunId})`,
  });
}

async function drainAsyncResults(
  reportRunId: string,
  perPageLimit: number | undefined,
): Promise<InsightsRow[]> {
  const limit = perPageLimit ?? 1000;
  const results: InsightsRow[] = [];
  let cursor: string | undefined;

  for (let safety = 0; safety < 1000; safety++) {
    const params: Record<string, string | number> = { limit };
    if (cursor) params.after = cursor;
    const page = await graphFetch<SyncPage>(`${reportRunId}/insights`, { params });
    results.push(...(page.data ?? []));
    cursor = page.paging?.next ? page.paging.cursors?.after : undefined;
    if (!cursor) break;
  }
  return results;
}

/**
 * Resume / inspect an existing async insights job.
 */
export async function getInsightsJobStatus(reportRunId: string): Promise<{
  id: string;
  async_status: string;
  async_percent_completion?: number;
  date_start?: string;
  date_stop?: string;
}> {
  return graphFetch(reportRunId, {
    params: {
      fields: "id,async_status,async_percent_completion,date_start,date_stop",
    },
  });
}
