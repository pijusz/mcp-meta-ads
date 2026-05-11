import {
  type McpServer,
  type ResourceMetadata,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorContents } from "@/resources/_helpers";
import { graphFetch, graphPaginate } from "@/services/meta-graph-api";

interface AdAccount {
  id: string;
  account_id?: string;
  name?: string;
  account_status?: number;
  currency?: string;
  timezone_name?: string;
  business?: { id: string; name?: string };
}

interface MeResponse {
  id: string;
  name?: string;
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
        const me = await graphFetch<MeResponse>("me", {
          params: { fields: "id,name" },
        });
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
      const params: Record<string, string | number | undefined> = {
        fields: uri.searchParams.get("fields") ?? ACCOUNT_FIELDS,
      };
      const cursor = uri.searchParams.get("cursor");
      if (cursor) params.cursor = cursor;
      const limit = uri.searchParams.get("limit");
      if (limit) {
        const parsedLimit = Number.parseInt(limit, 10);
        if (!Number.isFinite(parsedLimit)) {
          throw new Error(`Invalid limit: ${limit}`);
        }
        params.limit = parsedLimit;
      }
      const body = await graphPaginate<AdAccount>("me/adaccounts", { params });
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
