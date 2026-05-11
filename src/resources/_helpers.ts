import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { graphFetch, graphPaginate } from "@/services/meta-graph-api";
import { normalizeActId } from "@/utils/account-id";
import { MetaApiError } from "@/utils/errors";
import { paginationParams } from "@/utils/pagination";

export function errorContents(uri: string, err: unknown) {
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
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

export interface ListResourceConfig {
  /** Resource name used in MCP capability discovery. */
  name: string;
  /** URI template, e.g. `meta-ads://act_{accountId}/campaigns`. */
  uriTemplate: string;
  /** Graph API edge name, e.g. `campaigns`. */
  edge: string;
  /** Default comma-separated `fields` value when caller doesn't override. */
  defaultFields: string;
  title: string;
  description: string;
  /** Resource priority (0.0–1.0). */
  priority?: number;
}

/**
 * Register a paginated "list" resource under an ad account.
 * Honors `?cursor=`, `?limit=`, `?fields=` on the URI.
 */
export function registerListResource(server: McpServer, cfg: ListResourceConfig): void {
  registerListResourceVariant(server, cfg, cfg.name, cfg.uriTemplate);
  registerListResourceVariant(
    server,
    cfg,
    `${cfg.name}-query`,
    `${cfg.uriTemplate}{query}`,
  );
}

function registerListResourceVariant(
  server: McpServer,
  cfg: ListResourceConfig,
  name: string,
  uriTemplate: string,
): void {
  server.registerResource(
    name,
    new ResourceTemplate(uriTemplate, { list: undefined }),
    {
      title: cfg.title,
      description: cfg.description,
      mimeType: "application/json",
      annotations: { audience: ["assistant"], priority: cfg.priority ?? 0.8 },
    },
    async (uri, vars) => {
      try {
        const actId = normalizeActId(extractVar(vars, "accountId"));
        const params: Record<string, string | number | undefined> = {
          fields: uri.searchParams.get("fields") ?? cfg.defaultFields,
          ...paginationParams(uri.searchParams),
        };
        const result = await graphPaginate(`${actId}/${cfg.edge}`, { params });
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        return errorContents(uri.href, err);
      }
    },
  );
}

export interface SingleResourceConfig {
  name: string;
  uriTemplate: string;
  defaultFields: string;
  title: string;
  description: string;
  /** Which URI variable carries the object ID (e.g. "campaignId"). */
  idVar: string;
  priority?: number;
}

/**
 * Register a single-object resource template. The handler GETs the
 * Graph API object by ID.
 */
export function registerSingleResource(
  server: McpServer,
  cfg: SingleResourceConfig,
): void {
  registerSingleResourceVariant(server, cfg, cfg.name, cfg.uriTemplate);
  registerSingleResourceVariant(
    server,
    cfg,
    `${cfg.name}-query`,
    `${cfg.uriTemplate}{query}`,
  );
}

function registerSingleResourceVariant(
  server: McpServer,
  cfg: SingleResourceConfig,
  name: string,
  uriTemplate: string,
): void {
  server.registerResource(
    name,
    new ResourceTemplate(uriTemplate, { list: undefined }),
    {
      title: cfg.title,
      description: cfg.description,
      mimeType: "application/json",
      annotations: { audience: ["assistant"], priority: cfg.priority ?? 0.7 },
    },
    async (uri, vars) => {
      try {
        const id = extractVar(vars, cfg.idVar);
        const fields = uri.searchParams.get("fields") ?? cfg.defaultFields;
        const data = await graphFetch<unknown>(id, { params: { fields } });
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      } catch (err) {
        return errorContents(uri.href, err);
      }
    },
  );
}

function extractVar(vars: Record<string, string | string[]>, key: string): string {
  const v = vars[key];
  if (Array.isArray(v)) return v[0] ?? "";
  return v ?? "";
}
