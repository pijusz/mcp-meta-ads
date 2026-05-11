import { MetaApiError } from "@/utils/errors";

/**
 * Shared MCP tool-response helpers. Every tool file used to define local
 * `success` / `failure` / `stripUndefined` copies; centralized here so:
 *   - One place to evolve the error shape
 *   - Adding fields (e.g. fbtrace_id, hint translations) updates every tool
 *   - Tool files shrink by ~30-50 lines each
 */

/**
 * Success response. JSON-stringifies the payload (pretty-printed) into a
 * single text content block, matching the MCP tool response shape.
 *
 * Return type is intentionally inferred (not explicitly declared) so it
 * structurally satisfies the MCP SDK's CallToolResult type, which uses an
 * `[x: string]: unknown` index signature we'd otherwise have to model.
 */
export function ok(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

/**
 * Error response. Translates MetaApiError into the structured `{ error: {...} }`
 * payload with all the fields callers want for diagnosis (code, subcode, hint,
 * fbtrace_id). Non-MetaApiError values surface just `message`.
 */
export function fail(err: unknown) {
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
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    isError: true as const,
  };
}

/**
 * Wrap an async handler so common try/catch boilerplate disappears from each
 * tool. Handler returns its raw payload (any shape); we serialize on success,
 * route to `fail()` on throw.
 *
 * Usage:
 *   readTool(server, "name", "desc", schema, run(async ({ id }) => {
 *     return await fetchSomething(id);
 *   }));
 */
export function run<Args, P>(handler: (args: Args) => Promise<P>) {
  return async (args: Args) => {
    try {
      return ok(await handler(args));
    } catch (err) {
      return fail(err);
    }
  };
}

/**
 * Drop keys whose values are `undefined`. Used to assemble a partial-update
 * body that only contains fields the caller actually passed.
 */
export function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * Throw the standard "no fields to update" error from a partial-update tool
 * when the post-stripping body would be empty.
 */
export function assertHasFields(body: Record<string, unknown>): void {
  if (Object.keys(body).length === 0) {
    throw new MetaApiError({ message: "No fields to update." });
  }
}
