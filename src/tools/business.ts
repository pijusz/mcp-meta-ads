import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { graphFetch } from "@/services/meta-graph-api";
import { readTool } from "@/utils/register-tool";
import { fail, ok } from "@/utils/tool-response";

/**
 * Business Manager asset browsing.
 *
 * All read-only. Requires `business_management` permission on the token —
 * without it, /me/businesses returns 200 with empty data, and per-business
 * edges 403.
 *
 * "Owned" vs "client" matters: a BM owns some assets directly and has
 * client access (granted by another BM) to others. The list_business_*
 * tools accept an optional ownership filter; default is OWNED.
 */

const OWNERSHIP = z.enum(["OWNED", "CLIENT", "BOTH"]).default("OWNED");

interface BusinessListResponse {
  data?: Array<{
    id: string;
    name?: string;
    primary_page?: { id: string; name?: string };
    verification_status?: string;
  }>;
  paging?: { cursors?: { after?: string }; next?: string };
}

export function registerBusinessTools(server: McpServer): void {
  readTool(
    server,
    "list_businesses",
    "List Business Managers the access token can see (via /me/businesses). Requires business_management permission.",
    {
      limit: z.number().int().min(1).max(100).default(50),
      after: z.string().optional(),
    },
    async ({ limit, after }) => {
      try {
        const params: Record<string, string | number> = {
          fields: "id,name,primary_page,verification_status,timezone_id",
          limit,
        };
        if (after) params.after = after;
        const res = await graphFetch<BusinessListResponse>("me/businesses", {
          params,
        });
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
    "list_business_ad_accounts",
    "List ad accounts a Business Manager has access to (owned, client, or both).",
    {
      business_id: z.string(),
      ownership: OWNERSHIP,
      limit: z.number().int().min(1).max(100).default(100),
    },
    async ({ business_id, ownership, limit }) => {
      try {
        const accounts = await fetchBmEdges<{
          id: string;
          account_id?: string;
          name?: string;
          account_status?: number;
        }>(
          business_id,
          "ad_accounts",
          ownership,
          "id,account_id,name,account_status",
          limit,
        );
        return ok({ data: accounts });
      } catch (err) {
        return fail(err);
      }
    },
  );

  readTool(
    server,
    "list_business_pages",
    "List Facebook Pages a Business Manager has access to (owned, client, or both).",
    {
      business_id: z.string(),
      ownership: OWNERSHIP,
      limit: z.number().int().min(1).max(100).default(100),
    },
    async ({ business_id, ownership, limit }) => {
      try {
        const pages = await fetchBmEdges<{
          id: string;
          name?: string;
          category?: string;
        }>(business_id, "pages", ownership, "id,name,category", limit);
        return ok({ data: pages });
      } catch (err) {
        return fail(err);
      }
    },
  );

  readTool(
    server,
    "list_business_pixels",
    "List Meta Pixels a Business Manager has access to (owned, client, or both). Same shape as /act_X/adspixels but business-scoped.",
    {
      business_id: z.string(),
      ownership: OWNERSHIP,
      limit: z.number().int().min(1).max(100).default(100),
    },
    async ({ business_id, ownership, limit }) => {
      try {
        const pixels = await fetchBmEdges<{
          id: string;
          name?: string;
          code?: string;
          last_fired_time?: string;
        }>(business_id, "pixels", ownership, "id,name,code,last_fired_time", limit);
        return ok({ data: pixels });
      } catch (err) {
        return fail(err);
      }
    },
  );

  readTool(
    server,
    "list_business_system_users",
    "List System Users on a Business Manager. Requires admin role on the BM.",
    {
      business_id: z.string(),
      limit: z.number().int().min(1).max(100).default(50),
    },
    async ({ business_id, limit }) => {
      try {
        const res = await graphFetch<{
          data?: Array<{ id: string; name?: string; role?: string }>;
        }>(`${business_id}/system_users`, {
          params: { fields: "id,name,role", limit },
        });
        return ok({ data: res.data ?? [] });
      } catch (err) {
        return fail(err);
      }
    },
  );
}

/**
 * Fetch a BM edge with optional ownership combining: OWNED, CLIENT, or BOTH.
 * Meta exposes these as two separate edges (owned_X and client_X) without
 * an "all" variant — we union them here when ownership=BOTH.
 *
 * Exported for unit testing the edge-name + ownership logic.
 */
export async function fetchBmEdges<T extends { id: string }>(
  businessId: string,
  edgeBase: "ad_accounts" | "pages" | "pixels",
  ownership: "OWNED" | "CLIENT" | "BOTH",
  fields: string,
  limit: number,
): Promise<T[]> {
  const wantOwned = ownership === "OWNED" || ownership === "BOTH";
  const wantClient = ownership === "CLIENT" || ownership === "BOTH";
  const results: T[] = [];
  const seen = new Set<string>();

  if (wantOwned) {
    const res = await graphFetch<{ data?: T[] }>(`${businessId}/owned_${edgeBase}`, {
      params: { fields, limit },
    });
    for (const row of res.data ?? []) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        results.push(row);
      }
    }
  }
  if (wantClient) {
    const res = await graphFetch<{ data?: T[] }>(`${businessId}/client_${edgeBase}`, {
      params: { fields, limit },
    });
    for (const row of res.data ?? []) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        results.push(row);
      }
    }
  }
  return results;
}
