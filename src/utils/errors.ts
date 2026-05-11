/**
 * Translation table for the most common Meta Graph API error codes / subcodes,
 * mapped to a short human-readable hint. Extend over time.
 *
 * Reference: https://developers.facebook.com/docs/graph-api/guides/error-handling
 */
const HINTS: Record<string, string> = {
  // code only
  "1": "API unknown error — usually transient; retry once.",
  "2": "API service error — usually transient; retry once.",
  "4": "Application request limit reached — backing off.",
  "10": "Permission denied — check System User permissions on this account.",
  "17": "User request limit reached for this account.",
  "32": "Page-level throttling — retry after a short pause.",
  "100": "Invalid parameter or object — verify ID / fields.",
  "190":
    "Access token invalid or expired — regenerate System User token in Business Manager.",
  "200":
    "Permission denied — System User needs the appropriate role on the BM/ad account.",
  "270": "App not allowed to call this endpoint — check `ads_management` permission.",
  "294": "This endpoint requires the `ads_management` extended permission.",
  "368": "Temporarily blocked for policy violations.",
  "613": "Calls to this api have exceeded the rate limit.",
  "80000": "Ads Insights Business Use Case rate limit — backing off.",
  "80001": "Pages Business Use Case rate limit — backing off.",
  "80002": "Custom Audience Business Use Case rate limit — backing off.",
  "80004": "Ads Management Business Use Case rate limit — backing off.",
  // code:subcode
  "100:33": "Object doesn't exist or you don't have access.",
  "100:458": "User access expired — re-authorize.",
  "100:1487006": "Invalid parameter — verify the field shape against Meta's schema.",
  "100:1487079": "Invalid ad creative spec.",
  "100:1487390": "Adcreative create failed — bad combination of fields.",
  "100:1487504":
    "Ad creative missing call-to-action or required object_story_spec field.",
  "100:1815105": "Invalid ad image / video reference.",
  "190:458": "App not installed for user.",
  "190:460": "Password changed; token revoked. Regenerate the System User token.",
  "190:463": "Session expired — regenerate the token.",
  "190:467": "Token invalid — regenerate the System User token.",
  ":1487504": "Insights query too large — auto-async will engage.",
  ":2446079": "Business Use Case rate limit — backing off.",
};

export interface MetaErrorInfo {
  message: string;
  type?: string;
  code?: number;
  subcode?: number;
  fbtraceId?: string;
  hint?: string;
  status?: number;
  raw?: unknown;
}

export class MetaApiError extends Error {
  readonly type?: string;
  readonly code?: number;
  readonly subcode?: number;
  readonly fbtraceId?: string;
  readonly hint?: string;
  readonly status?: number;
  readonly raw?: unknown;

  constructor(info: MetaErrorInfo) {
    super(info.message);
    this.name = "MetaApiError";
    this.type = info.type;
    this.code = info.code;
    this.subcode = info.subcode;
    this.fbtraceId = info.fbtraceId;
    this.hint = info.hint;
    this.status = info.status;
    this.raw = info.raw;
  }
}

export function hintForError(code?: number, subcode?: number): string | undefined {
  if (code != null && subcode != null) {
    const key = `${code}:${subcode}`;
    if (HINTS[key]) return HINTS[key];
  }
  if (subcode != null && HINTS[`:${subcode}`]) {
    return HINTS[`:${subcode}`];
  }
  if (code != null && HINTS[String(code)]) {
    return HINTS[String(code)];
  }
  return undefined;
}

/**
 * Parse a Meta Graph API error envelope into a typed MetaApiError.
 *
 * Meta returns errors as:
 *   { error: { message, type, code, error_subcode?, fbtrace_id, ... } }
 */
export function parseGraphError(status: number, body: unknown): MetaApiError {
  const wrapper = body as { error?: Record<string, unknown> } | undefined;
  const err = wrapper?.error;
  if (!err) {
    return new MetaApiError({
      status,
      message: `Meta Graph API error (HTTP ${status}): ${JSON.stringify(body)}`,
      raw: body,
    });
  }
  const code = typeof err.code === "number" ? err.code : undefined;
  const subcode =
    typeof err.error_subcode === "number" ? (err.error_subcode as number) : undefined;
  return new MetaApiError({
    status,
    message: typeof err.message === "string" ? err.message : `HTTP ${status}`,
    type: typeof err.type === "string" ? err.type : undefined,
    code,
    subcode,
    fbtraceId: typeof err.fbtrace_id === "string" ? err.fbtrace_id : undefined,
    hint: hintForError(code, subcode),
    raw: body,
  });
}
