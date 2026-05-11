import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { graphFetch } from "@/services/meta-graph-api";
import { hashRow } from "@/services/pii";
import { normalizeActId } from "@/utils/account-id";
import { MetaApiError } from "@/utils/errors";
import { writeTool } from "@/utils/register-tool";

/**
 * Custom audience mutation tools. Part of v0.3.
 *
 * PII flow (decision #9 in docs/SPEC.md): callers pass raw values; the server
 * normalizes + SHA256-hashes per Meta spec via services/pii.ts before sending.
 * Raw PII never leaves the server process and is never logged.
 *
 * Schema field tokens used by Meta (per docs/RESEARCH.md §2.8):
 *   EMAIL · PHONE · FN · LN · DOB · CT · ST · ZIP · COUNTRY · GEN · MADID · EXTERN_ID
 */

const SUBTYPE = z.enum([
  "CUSTOM",
  "WEBSITE",
  "APP",
  "OFFLINE_CONVERSION",
  "CLAIM",
  "PARTNER",
  "MANAGED",
  "VIDEO",
  "LOOKALIKE",
  "ENGAGEMENT",
  "BAG_OF_ACCOUNTS",
  "STUDY_RULE_AUDIENCE",
  "FOX",
]);

const CUSTOMER_FILE_SOURCE = z.enum([
  "USER_PROVIDED_ONLY",
  "PARTNER_PROVIDED_ONLY",
  "BOTH_USER_AND_PARTNER_PROVIDED",
]);

const SCHEMA_FIELD = z.enum([
  "EMAIL",
  "PHONE",
  "GEN",
  "DOB",
  "DOBY",
  "DOBM",
  "DOBD",
  "LN",
  "FN",
  "FI",
  "CT",
  "ST",
  "ZIP",
  "COUNTRY",
  "MADID",
  "EXTERN_ID",
]);

interface AudienceCreateResponse {
  id: string;
}

interface UserBatchResponse {
  audience_id?: string;
  session_id?: number;
  num_received?: number;
  num_invalid_entries?: number;
  invalid_entry_samples?: string;
}

export function registerAudienceTools(server: McpServer): void {
  writeTool(
    server,
    "create_custom_audience",
    `⚠️ WRITE OPERATION — Create a new custom audience shell.

After creation, populate users via add_users_to_audience (for CUSTOM subtype) or define a website/app rule via the 'rule' field (for WEBSITE/APP subtypes).

For lookalikes, use create_lookalike instead — different params.`,
    {
      account_id: z.string(),
      name: z.string().min(1),
      description: z.string().optional(),
      subtype: SUBTYPE.default("CUSTOM"),
      customer_file_source: CUSTOMER_FILE_SOURCE.optional().describe(
        "Required for CUSTOM subtype. Indicates the provenance of the customer data.",
      ),
      retention_days: z
        .number()
        .int()
        .min(0)
        .max(540)
        .optional()
        .describe("Days to retain users in the audience. 0 = never expire."),
      rule: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Rule for WEBSITE / APP / ENGAGEMENT audiences."),
      extra: z.record(z.string(), z.unknown()).optional(),
    },
    async (args) => {
      try {
        const actId = normalizeActId(args.account_id);
        if (args.subtype === "CUSTOM" && !args.customer_file_source) {
          // Meta requires this for CUSTOM audiences; default to user-provided.
          // Users explicitly setting another value can do so.
          args.customer_file_source = "USER_PROVIDED_ONLY";
        }
        const body: Record<string, unknown> = {
          name: args.name,
          subtype: args.subtype,
          ...(args.description && { description: args.description }),
          ...(args.customer_file_source && {
            customer_file_source: args.customer_file_source,
          }),
          ...(args.retention_days !== undefined && {
            retention_days: args.retention_days,
          }),
          ...(args.rule && { rule: args.rule }),
          ...(args.extra ?? {}),
        };
        const res = await graphFetch<AudienceCreateResponse>(`${actId}/customaudiences`, {
          method: "POST",
          body,
        });
        return success({ id: res.id, subtype: args.subtype });
      } catch (err) {
        return failure(err);
      }
    },
  );

  writeTool(
    server,
    "add_users_to_audience",
    `⚠️ WRITE OPERATION — Add users to a custom audience. Server hashes raw PII per Meta's spec before sending.

Two input modes:
  1. Single-field shortcut — pass any of \`emails\`, \`phones\`, etc. as flat arrays. Server treats each as one user with that single field.
  2. Multi-field — pass \`schema\` (array of field tokens) + \`data\` (array of rows). Each row is one user with the same field order as schema.

For multi-batch uploads (>10,000 users), pass a stable \`session_id\` across calls and set \`last_batch_flag=true\` on the final batch.

Already-hashed SHA256 values are detected and passed through unchanged.`,
    {
      audience_id: z.string(),
      // Single-field shortcuts
      emails: z.array(z.string()).optional(),
      phones: z.array(z.string()).optional(),
      external_ids: z.array(z.string()).optional(),
      madids: z.array(z.string()).optional(),
      // Multi-field
      schema: z
        .array(SCHEMA_FIELD)
        .optional()
        .describe(
          "Multi-field schema tokens. Must match the column order of `data` rows.",
        ),
      data: z
        .array(z.array(z.string()))
        .optional()
        .describe("Rows of raw values aligned to `schema`."),
      // Session params
      session_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "64-bit session ID for multi-batch uploads. Auto-generated if omitted.",
        ),
      batch_seq: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("1-indexed batch sequence. Defaults to 1."),
      last_batch_flag: z
        .boolean()
        .optional()
        .describe(
          "Set true on the final batch of a session. Defaults to true if not part of multi-batch.",
        ),
      estimated_num_total: z.number().int().min(0).optional(),
    },
    async (args) => {
      try {
        // Build schema + data from inputs.
        const { schema, data } = normalizeUserInputs(args);
        if (schema.length === 0 || data.length === 0) {
          return failure(
            new MetaApiError({
              message:
                "Provide users to add: pass single-field arrays (emails / phones / etc.) or both `schema` and `data`.",
            }),
          );
        }
        if (data.length > 10_000) {
          return failure(
            new MetaApiError({
              message: `Meta caps customer file uploads at 10,000 rows per request; got ${data.length}. Split across multiple calls with a shared session_id.`,
            }),
          );
        }
        // Hash every row.
        const hashed = data.map((row) => hashRow(schema, row));

        const sessionId = args.session_id ?? Date.now();
        const isLast = args.last_batch_flag ?? args.batch_seq === undefined;
        const body = {
          payload: { schema, data: hashed },
          session: {
            session_id: sessionId,
            batch_seq: args.batch_seq ?? 1,
            last_batch_flag: isLast,
            ...(args.estimated_num_total !== undefined && {
              estimated_num_total: args.estimated_num_total,
            }),
          },
        };
        const res = await graphFetch<UserBatchResponse>(`${args.audience_id}/users`, {
          method: "POST",
          body,
        });
        return success({
          audience_id: args.audience_id,
          session_id: sessionId,
          num_received: res.num_received,
          num_invalid_entries: res.num_invalid_entries,
          invalid_entry_samples: res.invalid_entry_samples,
        });
      } catch (err) {
        return failure(err);
      }
    },
  );

  writeTool(
    server,
    "remove_users_from_audience",
    `⚠️ WRITE OPERATION — Remove users from a custom audience. Same input format as add_users_to_audience. Server hashes PII before sending.

Same 10,000-row cap per call; same session semantics.`,
    {
      audience_id: z.string(),
      emails: z.array(z.string()).optional(),
      phones: z.array(z.string()).optional(),
      external_ids: z.array(z.string()).optional(),
      madids: z.array(z.string()).optional(),
      schema: z.array(SCHEMA_FIELD).optional(),
      data: z.array(z.array(z.string())).optional(),
      session_id: z.number().int().positive().optional(),
      batch_seq: z.number().int().min(1).optional(),
      last_batch_flag: z.boolean().optional(),
    },
    async (args) => {
      try {
        const { schema, data } = normalizeUserInputs(args);
        if (schema.length === 0 || data.length === 0) {
          return failure(
            new MetaApiError({
              message:
                "Provide users to remove: pass single-field arrays or both `schema` and `data`.",
            }),
          );
        }
        if (data.length > 10_000) {
          return failure(
            new MetaApiError({
              message: `Meta caps customer file uploads at 10,000 rows per request; got ${data.length}.`,
            }),
          );
        }
        const hashed = data.map((row) => hashRow(schema, row));
        const sessionId = args.session_id ?? Date.now();
        const body = {
          payload: { schema, data: hashed },
          session: {
            session_id: sessionId,
            batch_seq: args.batch_seq ?? 1,
            last_batch_flag: args.last_batch_flag ?? args.batch_seq === undefined,
          },
        };
        const res = await graphFetch<UserBatchResponse>(`${args.audience_id}/users`, {
          method: "DELETE",
          body,
        });
        return success({
          audience_id: args.audience_id,
          session_id: sessionId,
          num_received: res.num_received,
        });
      } catch (err) {
        return failure(err);
      }
    },
  );

  writeTool(
    server,
    "update_audience",
    "⚠️ WRITE OPERATION — Update an audience's metadata (name, description, retention).",
    {
      audience_id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      retention_days: z.number().int().min(0).max(540).optional(),
      extra: z.record(z.string(), z.unknown()).optional(),
    },
    async (args) => {
      try {
        const { audience_id, extra, ...rest } = args;
        const body = stripUndefined({ ...rest, ...(extra ?? {}) });
        if (Object.keys(body).length === 0) {
          return failure(new MetaApiError({ message: "No fields to update." }));
        }
        const res = await graphFetch<{ success: boolean }>(audience_id, {
          method: "POST",
          body,
        });
        return success({ audience_id, success: res.success ?? true });
      } catch (err) {
        return failure(err);
      }
    },
  );

  writeTool(
    server,
    "delete_audience",
    "⚠️ WRITE OPERATION — Delete a custom audience. Audiences in active use by ad sets must be removed from those ad sets first.",
    { audience_id: z.string() },
    async ({ audience_id }) => {
      try {
        const res = await graphFetch<{ success?: boolean }>(audience_id, {
          method: "DELETE",
        });
        return success({ audience_id, deleted: res.success ?? true });
      } catch (err) {
        return failure(err);
      }
    },
  );

  writeTool(
    server,
    "create_lookalike",
    `⚠️ WRITE OPERATION — Create a lookalike audience derived from a source audience.

A lookalike picks users who behave similarly to your source audience, within a target country, at a specified ratio (1% = closest match / smallest reach, 10% = broadest / largest reach).

Lookalike audiences are themselves custom audiences with subtype=LOOKALIKE — they show up in list audience queries the same way.`,
    {
      account_id: z.string(),
      name: z.string().min(1),
      origin_audience_id: z.string().describe("Source custom audience ID."),
      country: z.string().length(2).describe("2-letter ISO country code, e.g. 'US'."),
      ratio: z
        .number()
        .min(0.01)
        .max(0.2)
        .default(0.01)
        .describe("Lookalike ratio: 0.01 (1%) closest match, up to 0.2 (20%) broadest."),
      description: z.string().optional(),
    },
    async (args) => {
      try {
        const actId = normalizeActId(args.account_id);
        const body = {
          name: args.name,
          subtype: "LOOKALIKE",
          origin_audience_id: args.origin_audience_id,
          lookalike_spec: {
            country: args.country.toUpperCase(),
            ratio: args.ratio,
            origin: [{ id: args.origin_audience_id, type: "custom_audience" }],
          },
          ...(args.description && { description: args.description }),
        };
        const res = await graphFetch<AudienceCreateResponse>(`${actId}/customaudiences`, {
          method: "POST",
          body,
        });
        return success({ id: res.id, ratio: args.ratio, country: args.country });
      } catch (err) {
        return failure(err);
      }
    },
  );
}

/**
 * Convert user-input modes into a unified { schema, data } pair.
 * Exported for testing.
 *
 * Three valid input shapes:
 *   1. Multi-field: caller supplies `schema` + `data` directly.
 *   2. Single-field shortcut: exactly ONE of `emails` / `phones` / `external_ids`
 *      / `madids` populated. Each value becomes one row.
 *   3. Empty: returns { schema: [], data: [] } so the handler can surface a
 *      clear "no users provided" error.
 *
 * Mixing multiple shortcut arrays (e.g. `emails` AND `phones`) is rejected
 * with a thrown error — zipping them is ambiguous (are arr[i] entries the
 * same user or different users?) and silently dropping all but the first
 * is worse. Use multi-field mode if you need multiple PII columns per user.
 */
export function normalizeUserInputs(args: {
  emails?: string[];
  phones?: string[];
  external_ids?: string[];
  madids?: string[];
  schema?: readonly string[];
  data?: string[][];
}): { schema: string[]; data: string[][] } {
  // If multi-field mode supplied, use it directly.
  if (args.schema?.length && args.data?.length) {
    return { schema: [...args.schema], data: args.data };
  }

  const populated = (
    [
      ["EMAIL", args.emails],
      ["PHONE", args.phones],
      ["EXTERN_ID", args.external_ids],
      ["MADID", args.madids],
    ] as const
  ).filter(([, values]) => values && values.length > 0);

  if (populated.length === 0) {
    return { schema: [], data: [] };
  }

  if (populated.length > 1) {
    const names = populated.map(([k]) => k.toLowerCase()).join(", ");
    throw new Error(
      `Mixed PII shortcuts not supported (got: ${names}). Each shortcut treats values as 1-column rows, so combining them would require zipping arrays by index — which is ambiguous about whether arr[i] entries describe one user or different users. Use multi-field mode instead: pass \`schema: ['EMAIL','PHONE',...]\` + \`data: [['a@b.com','+1...'], ...]\`.`,
    );
  }

  const [field, values] = populated[0];
  return {
    schema: [field],
    data: (values as string[]).map((v) => [v]),
  };
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function success(payload: Record<string, unknown>): {
  content: Array<{ type: "text"; text: string }>;
} {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function failure(err: unknown): {
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
