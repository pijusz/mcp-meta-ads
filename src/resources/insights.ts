import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorContents } from "@/resources/_helpers";
import { type InsightsQuery, runInsights } from "@/services/insights";
import { normalizeActId } from "@/utils/account-id";
import { rowsToTsv } from "@/utils/tsv";

/**
 * Insights resource: `meta-ads://act_{accountId}/insights?level=...&date_preset=...`
 *
 * Tabular output is TSV (text/tab-separated-values) — much smaller than JSON
 * for the wide rows insights returns.
 */
export function registerInsightsResources(server: McpServer): void {
  registerInsightsResourceVariant(
    server,
    "insights",
    "meta-ads://act_{accountId}/insights",
  );
  registerInsightsResourceVariant(
    server,
    "insights-query",
    "meta-ads://act_{accountId}/insights{query}",
  );
}

function registerInsightsResourceVariant(
  server: McpServer,
  name: string,
  uriTemplate: string,
): void {
  server.registerResource(
    name,
    new ResourceTemplate(uriTemplate, { list: undefined }),
    {
      title: "Ad account insights",
      description:
        "Performance metrics. Supports ?level, ?fields, ?breakdowns, ?action_breakdowns, ?date_preset OR ?time_range.since+?time_range.until, ?time_increment, ?action_attribution_windows, ?filtering, ?limit, ?compact. Auto-falls back to async when Meta requires it.",
      mimeType: "text/tab-separated-values",
      annotations: { audience: ["assistant"], priority: 0.95 },
    },
    async (uri, vars) => {
      try {
        const actId = normalizeActId(
          Array.isArray(vars.accountId) ? vars.accountId[0] : vars.accountId,
        );
        const query = parseInsightsParams(uri.searchParams);
        const { data } = await runInsights(actId, query);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/tab-separated-values",
              text: rowsToTsv(data),
            },
          ],
        };
      } catch (err) {
        return errorContents(uri.href, err);
      }
    },
  );
}

function parseInsightsParams(params: URLSearchParams): InsightsQuery {
  const query: InsightsQuery = {};
  const level = params.get("level");
  if (
    level === "account" ||
    level === "campaign" ||
    level === "adset" ||
    level === "ad"
  ) {
    query.level = level;
  }
  const fields = params.get("fields");
  if (fields)
    query.fields = fields
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const breakdowns = params.get("breakdowns");
  if (breakdowns) {
    query.breakdowns = breakdowns
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const actionBreakdowns = params.get("action_breakdowns");
  if (actionBreakdowns) {
    query.action_breakdowns = actionBreakdowns
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const since = params.get("time_range.since") ?? params.get("since");
  const until = params.get("time_range.until") ?? params.get("until");
  if (since && until) query.time_range = { since, until };
  const datePreset = params.get("date_preset");
  if (datePreset) query.date_preset = datePreset;
  const timeIncrement = params.get("time_increment");
  if (timeIncrement) query.time_increment = timeIncrement;
  const attrWindows = params.get("action_attribution_windows");
  if (attrWindows) {
    query.action_attribution_windows = attrWindows
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const filtering = params.get("filtering");
  if (filtering) {
    try {
      const parsed = JSON.parse(filtering);
      if (!Array.isArray(parsed)) {
        throw new Error("filtering must be a JSON array");
      }
      query.filtering = parsed;
    } catch (err) {
      throw new Error(`Invalid filtering JSON: ${(err as Error).message}`);
    }
  }
  const limit = params.get("limit");
  if (limit) {
    const parsedLimit = Number.parseInt(limit, 10);
    if (!Number.isFinite(parsedLimit)) {
      throw new Error(`Invalid limit: ${limit}`);
    }
    query.limit = parsedLimit;
  }
  if (params.get("compact") === "true") query.compact = true;
  return query;
}
