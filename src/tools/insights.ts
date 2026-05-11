import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getInsightsJobStatus,
  type InsightsQuery,
  runInsights,
} from "../services/insights.js";
import { normalizeActId } from "../utils/account-id.js";
import { MetaApiError } from "../utils/errors.js";
import { readTool } from "../utils/register-tool.js";

const LEVEL = z.enum(["account", "campaign", "adset", "ad"]);

const DESCRIPTION = `Get Meta ads performance insights for an account.
Auto-falls back to async report job when Meta says the query is too large.

Conventions:
- Default fields: impressions, clicks, spend, actions.
- Default attribution windows: 1d_click, 7d_click (7d-view + 28d-view were removed by Meta in Jan 2026).
- 'compact: true' strips duplicate omni_*/offsite_* entries from actions[] (~60% smaller payload).
- Output 'tsv' by default; switch to 'json' for nested rows you need to read structurally.

Common breakdowns: age, gender, country, region, publisher_platform, platform_position, device_platform, impression_device, dma.
Common action_breakdowns: action_type, action_destination, action_target_id.`;

export function registerInsightsTools(server: McpServer): void {
  readTool(
    server,
    "run_insights",
    DESCRIPTION,
    {
      account_id: z.string().describe("Ad account ID, with or without 'act_' prefix."),
      level: LEVEL.optional().describe("Aggregation level. Default: campaign."),
      fields: z
        .array(z.string())
        .optional()
        .describe(
          "Insights fields. Default: impressions, clicks, spend, actions. Common adds: cpc, ctr, cpm, reach, frequency, video_p25_watched_actions, conversions.",
        ),
      breakdowns: z
        .array(z.string())
        .optional()
        .describe(
          "Row breakdowns (e.g. age, gender, publisher_platform, country). Some combinations are incompatible — the server auto-fixes the common ones.",
        ),
      action_breakdowns: z
        .array(z.string())
        .optional()
        .describe(
          "How to split the actions array (e.g. action_type, action_destination).",
        ),
      time_range: z
        .object({
          since: z.string().describe("YYYY-MM-DD"),
          until: z.string().describe("YYYY-MM-DD"),
        })
        .optional()
        .describe("Explicit date range. Mutually exclusive with date_preset."),
      date_preset: z
        .string()
        .optional()
        .describe(
          "One of: today, yesterday, last_3d, last_7d, last_14d, last_28d, last_30d, last_90d, this_month, last_month, this_quarter, last_quarter, this_year, last_year, maximum.",
        ),
      time_increment: z
        .union([z.string(), z.number()])
        .optional()
        .describe(
          "Bucket size. Number = days (e.g. 1 = daily). Strings: 'monthly', 'all_days'.",
        ),
      action_attribution_windows: z
        .array(z.string())
        .optional()
        .describe(
          "Default ['1d_click','7d_click']. 7d_view / 28d_view return zeros as of Jan 2026.",
        ),
      filtering: z
        .array(z.record(z.string(), z.unknown()))
        .optional()
        .describe(
          "Server-side row filters, e.g. [{field:'campaign.name', operator:'CONTAIN', value:'Brand'}]",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe("Page size for results (sync) or per-page draining (async)."),
      compact: z
        .boolean()
        .optional()
        .describe(
          "Strip omni_*/offsite_* duplicates from actions[]. Significant token savings.",
        ),
      format: z
        .enum(["tsv", "json"])
        .default("tsv")
        .describe("Output format. TSV is dense and token-efficient."),
    },
    async (args) => {
      try {
        const actId = normalizeActId(args.account_id);
        const query: InsightsQuery = {
          level: args.level,
          fields: args.fields,
          breakdowns: args.breakdowns,
          action_breakdowns: args.action_breakdowns,
          time_range: args.time_range,
          date_preset: args.date_preset,
          time_increment: args.time_increment,
          action_attribution_windows: args.action_attribution_windows,
          filtering: args.filtering,
          limit: args.limit,
          compact: args.compact,
        };
        const result = await runInsights(actId, query);
        const text =
          args.format === "json"
            ? JSON.stringify(
                {
                  mode: result.mode,
                  report_run_id: result.report_run_id,
                  data: result.data,
                },
                null,
                2,
              )
            : `# mode=${result.mode}${result.report_run_id ? ` report_run_id=${result.report_run_id}` : ""}\n${rowsToTsv(result.data)}`;
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  readTool(
    server,
    "get_insights_job",
    `Inspect an async insights report job (returned by run_insights when the query falls back to async). Use the report_run_id from a prior run_insights response.`,
    {
      report_run_id: z
        .string()
        .describe("Report run ID from a prior async insights call."),
    },
    async ({ report_run_id }) => {
      try {
        const status = await getInsightsJobStatus(report_run_id);
        return {
          content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
        };
      } catch (err) {
        return errorContent(err);
      }
    },
  );
}

function rowsToTsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const cols = new Set<string>();
  for (const row of rows.slice(0, 50)) for (const k of Object.keys(row)) cols.add(k);
  const headers = Array.from(cols);
  const escapeCell = (v: unknown): string => {
    if (v == null) return "";
    if (typeof v === "object") return JSON.stringify(v).replace(/[\t\n\r]/g, " ");
    return String(v).replace(/[\t\n\r]/g, " ");
  };
  const body = rows
    .map((row) => headers.map((h) => escapeCell(row[h])).join("\t"))
    .join("\n");
  return `${headers.join("\t")}\n${body}`;
}

function errorContent(err: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  const payload =
    err instanceof MetaApiError
      ? {
          error: {
            message: err.message,
            type: err.type,
            code: err.code,
            subcode: err.subcode,
            fbtrace_id: err.fbtraceId,
            hint: err.hint,
            status: err.status,
          },
        }
      : { error: { message: (err as Error).message ?? String(err) } };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}
