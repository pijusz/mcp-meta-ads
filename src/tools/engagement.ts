import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { graphFetch } from "@/services/meta-graph-api";
import { readTool } from "@/utils/register-tool";
import { fail, ok } from "@/utils/tool-response";

/**
 * Page engagement reads — comments on posts, post insights, page insights.
 *
 * All read-only. The Graph API endpoints here typically require:
 *   - `pages_read_engagement` permission on the token (for comments)
 *   - `read_insights` (for page/post insights)
 *   - A page access token with Manage permission on the page is the typical
 *     setup; user/system tokens scoped to the page work too.
 */

const PAGE_INSIGHTS_PERIOD = z.enum(["day", "days_28", "week", "month", "lifetime"]);

export function registerEngagementTools(server: McpServer): void {
  readTool(
    server,
    "list_post_comments",
    `List comments on a post (page post, ad creative-attached post, etc.).

For ads management, the most common use is reading comments on an ad's underlying post — pass the effective_object_story_id from the ad's creative.

Returns top-level comments by default. Pass include_replies=true to also fetch nested replies (still one page; doesn't recursively walk deep threads).`,
    {
      post_id: z
        .string()
        .describe(
          "Post ID. Format depends on origin: '{page_id}_{post_id}' for page posts, an ig_media id for Instagram media, etc.",
        ),
      limit: z.number().int().min(1).max(100).default(25),
      after: z
        .string()
        .optional()
        .describe("Pagination cursor (`paging.cursors.after`)."),
      include_replies: z
        .boolean()
        .default(false)
        .describe(
          "Include nested reply comments. Each comment's `comments.data` will be populated.",
        ),
      fields: z
        .string()
        .optional()
        .describe(
          "Override default fields. Defaults: id,message,from{id,name},created_time,like_count,comment_count,parent.",
        ),
    },
    async (args) => {
      try {
        const baseFields =
          args.fields ??
          "id,message,from{id,name},created_time,like_count,comment_count,parent";
        const fields = args.include_replies
          ? `${baseFields},comments{${baseFields}}`
          : baseFields;
        const params: Record<string, string | number> = {
          fields,
          limit: args.limit,
        };
        if (args.after) params.after = args.after;
        const res = await graphFetch<{
          data?: Array<Record<string, unknown>>;
          paging?: { cursors?: { after?: string }; next?: string };
        }>(`${args.post_id}/comments`, { params });
        const nextCursor = res.paging?.next ? res.paging.cursors?.after : undefined;
        return ok({
          data: res.data ?? [],
          ...(nextCursor && { next_cursor: nextCursor }),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  readTool(
    server,
    "get_post_insights",
    `Read insights for a single post — impressions, reactions, video views, etc.

Common metrics: post_impressions, post_impressions_unique, post_reactions_by_type_total, post_engaged_users, post_video_views, post_clicks. Pass an array of metric names; Meta returns each with its value series.`,
    {
      post_id: z.string(),
      metrics: z
        .array(z.string())
        .default([
          "post_impressions",
          "post_impressions_unique",
          "post_engaged_users",
          "post_reactions_by_type_total",
        ])
        .describe("Metric names to fetch. Each returns its own series."),
    },
    async ({ post_id, metrics }) => {
      try {
        const res = await graphFetch<{
          data?: Array<{ name: string; period?: string; values?: unknown[] }>;
        }>(`${post_id}/insights`, {
          params: { metric: metrics.join(",") },
        });
        return ok({ data: res.data ?? [] });
      } catch (err) {
        return fail(err);
      }
    },
  );

  readTool(
    server,
    "get_page_insights",
    `Read page-level insights — followers, impressions, engagement, etc.

Period controls time granularity: 'day' (daily series), 'week' / 'days_28' (rolling window endpoints), 'month' (monthly aggregates), 'lifetime' (cumulative).

Examples of common metrics: page_fans, page_fan_adds, page_impressions, page_engaged_users, page_views_total.`,
    {
      page_id: z.string(),
      metrics: z.array(z.string()).min(1),
      period: PAGE_INSIGHTS_PERIOD.default("day"),
      since: z
        .string()
        .optional()
        .describe("ISO date or Unix timestamp. Defaults to ~7d ago for daily metrics."),
      until: z
        .string()
        .optional()
        .describe("ISO date or Unix timestamp. Defaults to now."),
    },
    async (args) => {
      try {
        const params: Record<string, string | number> = {
          metric: args.metrics.join(","),
          period: args.period,
        };
        if (args.since) params.since = args.since;
        if (args.until) params.until = args.until;
        const res = await graphFetch<{
          data?: Array<{ name: string; values?: unknown[] }>;
        }>(`${args.page_id}/insights`, { params });
        return ok({ data: res.data ?? [] });
      } catch (err) {
        return fail(err);
      }
    },
  );
}
