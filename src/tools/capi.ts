import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { graphFetch } from "@/services/meta-graph-api";
import { hashField } from "@/services/pii";
import { readTool, writeTool } from "@/utils/register-tool";
import { fail, ok } from "@/utils/tool-response";

/**
 * Conversions API (CAPI) — server-side event ingestion + pixel reads.
 *
 * Per docs/SPEC.md decision #11, full CAPI is in scope. Per decision #9, the
 * server hashes raw PII before sending. CAPI uses short field names (em, ph,
 * fn, ...) — different from the custom-audience customer file upload — so we
 * map them to the existing services/pii.ts normalizers.
 *
 * Per docs/RESEARCH.md §2.6:
 *   - NOT hashed: client_ip_address, client_user_agent, fbc, fbp
 *   - event_id matches the Pixel `eventID` for browser+CAPI dedup (48h window)
 *   - test_event_code routes to the Test Events tab in Events Manager for debugging
 */

/**
 * CAPI short-name → normalizer-table token (in services/pii.ts).
 * Every PII-bearing field MUST appear here; anything in CAPI_RAW_FIELDS bypasses
 * hashing entirely, so the only entries there should be Meta fields that the
 * spec explicitly says NOT to hash.
 */
const CAPI_TO_CUSTAUD: Record<string, string> = {
  em: "EMAIL",
  ph: "PHONE",
  fn: "FN",
  ln: "LN",
  ge: "GEN",
  db: "DOB",
  ct: "CT",
  st: "ST",
  zp: "ZIP",
  country: "COUNTRY",
  external_id: "EXTERN_ID",
  madid: "MADID",
  // CAPI-specific PII fields — must be hashed per Meta spec.
  f5first: "F5FIRST",
  f5last: "F5LAST",
  fi: "FI",
  doby: "DOBY",
  dobm: "DOBM",
  dobd: "DOBD",
};

/**
 * Fields that must NOT be hashed (per Meta CAPI spec — these are signals,
 * not identifiers, or are already-opaque tokens Meta uses for matching).
 * KEEP THIS LIST TIGHT — adding a PII field here silently leaks raw PII.
 */
const CAPI_RAW_FIELDS = new Set([
  "client_ip_address",
  "client_user_agent",
  "fbc",
  "fbp",
  "subscription_id",
  "lead_id",
  "anon_id",
  "fb_login_id",
]);

const ACTION_SOURCE = z.enum([
  "email",
  "website",
  "phone_call",
  "chat",
  "physical_store",
  "system_generated",
  "business_messaging",
  "other",
  "app",
]);

interface CapiResponse {
  events_received?: number;
  messages?: string[];
  fbtrace_id?: string;
}

export function registerCapiTools(server: McpServer): void {
  writeTool(
    server,
    "send_conversion_events",
    `⚠️ WRITE OPERATION — Send events to a Meta Pixel via the Conversions API.

CAPI event writes are permanent — there's no "delete events" endpoint, only deduplication via event_id. Use test_event_code to route events to the Events Manager Test Events tab during development, but still use a dedicated test pixel/account unless you're comfortable with Meta processing the events.

PII fields in user_data are hashed server-side per Meta's CAPI spec:
  HASHED: em, ph, fn, ln, ge, db, ct, st, zp, country, external_id, madid, f5first, f5last, fi, doby, dobm, dobd
  RAW:    client_ip_address, client_user_agent, fbc, fbp, subscription_id, lead_id, anon_id, fb_login_id

For event deduplication with the browser-side Meta Pixel, set event_id to match the Pixel's eventID parameter. Dedup window is 48h.`,
    {
      pixel_id: z.string(),
      test_event_code: z
        .string()
        .optional()
        .describe(
          "When set, events route to the Test Events tab in Events Manager for debugging. Use a dedicated test pixel/account for development events.",
        ),
      events: z
        .array(
          z.object({
            event_name: z
              .string()
              .describe(
                "Meta-standard or custom event name. Standard: PageView, ViewContent, AddToCart, InitiateCheckout, Purchase, Lead, CompleteRegistration, etc.",
              ),
            event_time: z
              .number()
              .int()
              .optional()
              .describe(
                "Unix timestamp (seconds). Defaults to 'now'. Meta accepts events up to 7 days old.",
              ),
            event_id: z.string().optional(),
            event_source_url: z
              .string()
              .url()
              .optional()
              .describe("Required if action_source='website'."),
            action_source: ACTION_SOURCE,
            user_data: z
              .record(z.string(), z.unknown())
              .describe(
                "Identifiers + signals. Hashable fields are normalized + SHA256'd by the server; raw fields are passed through unchanged.",
              ),
            custom_data: z
              .record(z.string(), z.unknown())
              .optional()
              .describe(
                "Event-specific payload: currency, value, content_ids, contents[], order_id, etc.",
              ),
            data_processing_options: z
              .array(z.string())
              .optional()
              .describe("E.g. ['LDU'] to enable Limited Data Use for CCPA opt-out."),
            data_processing_options_country: z.number().int().optional(),
            data_processing_options_state: z.number().int().optional(),
            opt_out: z.boolean().optional(),
          }),
        )
        .min(1)
        .max(1000)
        .describe(
          "Batch of events. Meta caps at 1000 per request. For larger batches, split across calls.",
        ),
      partner_agent: z
        .string()
        .optional()
        .describe(
          "Identifier for the source SDK / partner integration. Defaults to 'mcp-meta-ads'.",
        ),
    },
    async (args) => {
      try {
        const data = args.events.map((ev) => prepareEvent(ev));
        const body: Record<string, unknown> = {
          data,
          partner_agent: args.partner_agent ?? "mcp-meta-ads",
        };
        if (args.test_event_code) body.test_event_code = args.test_event_code;
        const res = await graphFetch<CapiResponse>(`${args.pixel_id}/events`, {
          method: "POST",
          body,
        });
        return ok({
          events_received: res.events_received,
          messages: res.messages,
          fbtrace_id: res.fbtrace_id,
          mode: args.test_event_code ? "test" : "live",
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  readTool(
    server,
    "read_pixel_events",
    `Read aggregate stats for a Pixel — event counts grouped by event name, over a time range.

This is NOT a per-event log — Meta doesn't expose individual events as a stream. Use this to verify your CAPI events are landing (count goes up) and to monitor event volumes day-to-day.`,
    {
      pixel_id: z.string(),
      start_time: z
        .number()
        .int()
        .optional()
        .describe("Unix timestamp (seconds) — start of window. Defaults to 24h ago."),
      end_time: z
        .number()
        .int()
        .optional()
        .describe("Unix timestamp (seconds). Defaults to now."),
      aggregation: z
        .enum(["event", "browser_type", "device_os"])
        .default("event")
        .describe("How to group the stats."),
    },
    async (args) => {
      try {
        const now = Math.floor(Date.now() / 1000);
        const params: Record<string, string | number> = {
          aggregation: args.aggregation,
          start_time: args.start_time ?? now - 86_400,
          end_time: args.end_time ?? now,
        };
        const res = await graphFetch<{ data?: Array<Record<string, unknown>> }>(
          `${args.pixel_id}/stats`,
          { params },
        );
        return ok({ data: res.data ?? [] });
      } catch (err) {
        return fail(err);
      }
    },
  );

  readTool(
    server,
    "list_pixels",
    "List Meta Pixels accessible from the ad account. Returns pixel IDs you can pass to send_conversion_events and read_pixel_events.",
    {
      account_id: z.string().describe("Ad account ID, with or without 'act_' prefix."),
    },
    async ({ account_id }) => {
      try {
        const actId = account_id.startsWith("act_") ? account_id : `act_${account_id}`;
        const res = await graphFetch<{
          data?: Array<{ id: string; name?: string; code?: string }>;
        }>(`${actId}/adspixels`, {
          params: { fields: "id,name,code,creation_time,last_fired_time", limit: 100 },
        });
        return ok({ data: res.data ?? [] });
      } catch (err) {
        return fail(err);
      }
    },
  );
}

/**
 * Take one event input and return the Meta-shaped event with user_data hashed.
 * Exported for unit testing.
 */
export function prepareEvent(event: {
  event_name: string;
  event_time?: number;
  event_id?: string;
  event_source_url?: string;
  action_source: string;
  user_data: Record<string, unknown>;
  custom_data?: Record<string, unknown>;
  data_processing_options?: string[];
  data_processing_options_country?: number;
  data_processing_options_state?: number;
  opt_out?: boolean;
}): Record<string, unknown> {
  if (event.action_source === "website") {
    if (!event.event_source_url) {
      throw new Error("event_source_url is required when action_source is 'website'.");
    }
    const userAgent = event.user_data.client_user_agent;
    if (typeof userAgent !== "string" || !userAgent.trim()) {
      throw new Error(
        "user_data.client_user_agent is required when action_source is 'website'.",
      );
    }
  }

  return {
    event_name: event.event_name,
    event_time: event.event_time ?? Math.floor(Date.now() / 1000),
    action_source: event.action_source,
    ...(event.event_id && { event_id: event.event_id }),
    ...(event.event_source_url && { event_source_url: event.event_source_url }),
    user_data: hashCapiUserData(event.user_data),
    ...(event.custom_data && { custom_data: event.custom_data }),
    ...(event.data_processing_options && {
      data_processing_options: event.data_processing_options,
    }),
    ...(event.data_processing_options_country !== undefined && {
      data_processing_options_country: event.data_processing_options_country,
    }),
    ...(event.data_processing_options_state !== undefined && {
      data_processing_options_state: event.data_processing_options_state,
    }),
    ...(event.opt_out !== undefined && { opt_out: event.opt_out }),
  };
}

/**
 * Hash CAPI user_data fields per Meta's normalization spec.
 * Hashable fields → SHA256 (normalized first). Raw fields pass through.
 * Array values get hashed element-wise.
 *
 * Exported for unit testing.
 */
export function hashCapiUserData(
  userData: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Use COUNTRY from this user_data (if present) to drive ZIP normalization.
  const countryRaw = userData.country;
  const countryStr =
    typeof countryRaw === "string"
      ? countryRaw
      : Array.isArray(countryRaw) && typeof countryRaw[0] === "string"
        ? (countryRaw[0] as string)
        : undefined;
  const country = countryStr?.trim().toLowerCase().slice(0, 2);
  const context = country ? { country } : undefined;

  for (const [key, value] of Object.entries(userData)) {
    if (value == null || value === "") continue;
    if (CAPI_RAW_FIELDS.has(key)) {
      out[key] = value;
      continue;
    }
    const schemaToken = CAPI_TO_CUSTAUD[key];
    if (!schemaToken) {
      throw new Error(
        `Unsupported CAPI user_data field "${key}". Add it explicitly so the server can decide whether Meta requires hashing or raw pass-through.`,
      );
    }
    // Hash. Array → hash each element; scalar → single-element wrapper Meta
    // accepts both, but arrays are the documented shape.
    const values = Array.isArray(value) ? value : [value];
    const hashed = values
      .map((v) => {
        if (typeof v !== "string") {
          throw new Error(
            `Invalid CAPI user_data field "${key}" — expected a string or string array.`,
          );
        }
        return hashField(schemaToken, v, context);
      })
      .filter((h) => h !== "");
    if (hashed.length > 0) {
      out[key] = hashed.length === 1 ? hashed : hashed;
    }
  }
  return out;
}
