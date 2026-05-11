import {
  type McpServer,
  type ResourceMetadata,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { getEnv } from "@/config/env";
import { errorContents } from "@/resources/_helpers";
import { cached, tokenKey } from "@/services/cache";
import { graphPaginate, validateToken } from "@/services/meta-graph-api";

const ACCOUNTS_TTL_MS = 5 * 60 * 1000; // 5 min — accounts list rarely changes

interface AdAccount {
  id: string;
  account_id?: string;
  name?: string;
  account_status?: number;
  currency?: string;
  timezone_name?: string;
  business?: { id: string; name?: string };
}

const ACCOUNT_FIELDS = [
  "id",
  "account_id",
  "name",
  "account_status",
  "currency",
  "timezone_name",
  "business",
].join(",");

export function registerAccountResources(server: McpServer): void {
  server.registerResource(
    "me",
    "meta-ads://me",
    {
      title: "Current user / System User identity",
      description:
        "Identity of the access token holder. Use this to confirm which System User the server is acting as.",
      mimeType: "application/json",
      annotations: { audience: ["assistant"], priority: 0.5 },
    },
    async (uri) => {
      try {
        // validateToken() caches the /me response per-token for the process
        // lifetime. Subsequent reads of meta-ads://me are free.
        const me = await validateToken();
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(me, null, 2),
            },
          ],
        };
      } catch (err) {
        return errorContents(uri.href, err);
      }
    },
  );

  const accountMetadata: ResourceMetadata = {
    title: "Accessible ad accounts",
    description:
      "Ad accounts the configured System User token can access. Use the returned account IDs as `act_<id>` in other resources and tools.",
    mimeType: "application/json",
    annotations: { audience: ["assistant"], priority: 0.9 },
  };

  const readAccounts = async (uri: URL) => {
    try {
      const fields = uri.searchParams.get("fields") ?? ACCOUNT_FIELDS;
      const cursor = uri.searchParams.get("cursor");
      const limit = uri.searchParams.get("limit");
      const parsedLimit = limit ? Number.parseInt(limit, 10) : undefined;
      if (limit && !Number.isFinite(parsedLimit)) {
        throw new Error(`Invalid limit: ${limit}`);
      }

      // Cache the first page of the default field set per-token. Paginated /
      // custom-fields requests skip the cache (they're rare and the cache key
      // surface would explode). Auth errors elsewhere will invalidate this
      // (see graphFetch 401/403 handler).
      const isDefaultFirstPage =
        !cursor && parsedLimit === undefined && fields === ACCOUNT_FIELDS;

      const params: Record<string, string | number | undefined> = { fields };
      if (cursor) params.cursor = cursor;
      if (parsedLimit !== undefined) params.limit = parsedLimit;

      const fetchAccounts = () => graphPaginate<AdAccount>("me/adaccounts", { params });

      const body = isDefaultFirstPage
        ? await cached(
            tokenKey(getEnv().META_ADS_ACCESS_TOKEN, "me/adaccounts"),
            ACCOUNTS_TTL_MS,
            fetchAccounts,
          )
        : await fetchAccounts();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(body, null, 2),
          },
        ],
      };
    } catch (err) {
      return errorContents(uri.href, err);
    }
  };

  server.registerResource(
    "accounts",
    "meta-ads://accounts",
    accountMetadata,
    readAccounts,
  );
  server.registerResource(
    "accounts-query",
    new ResourceTemplate("meta-ads://accounts{query}", { list: undefined }),
    accountMetadata,
    readAccounts,
  );
}
