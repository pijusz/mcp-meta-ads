/**
 * Response formatters used by tools and resources.
 *
 * Rule (see docs/SPEC.md §6.5):
 *   - Single objects → pretty JSON
 *   - Lists + cursor → JSON `{ data, next_cursor? }`
 *   - Tabular (insights) → TSV with header row
 *   - Errors → JSON `{ error: { ..., hint? } }`
 */

export function asJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function asJsonList<T>(data: T[], nextCursor?: string): string {
  const payload: { data: T[]; next_cursor?: string } = { data };
  if (nextCursor) payload.next_cursor = nextCursor;
  return JSON.stringify(payload, null, 2);
}

/**
 * Serialize a tabular dataset (array of rows) to TSV.
 * Columns are derived from the first row's key order unless `columns` is provided.
 * Tabs and newlines in values are escaped to spaces.
 */
export function asTsv(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  if (rows.length === 0) {
    return columns?.join("\t") ?? "";
  }
  const cols = columns ?? Object.keys(rows[0] ?? {});
  const header = cols.join("\t");
  const body = rows
    .map((row) => cols.map((c) => escapeTsv(row[c])).join("\t"))
    .join("\n");
  return `${header}\n${body}`;
}

function escapeTsv(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value).replace(/[\t\n\r]/g, " ");
  return String(value).replace(/[\t\n\r]/g, " ");
}

export function asError(err: {
  message: string;
  code?: number | string;
  subcode?: number | string;
  type?: string;
  fbtraceId?: string;
  hint?: string;
}): string {
  return JSON.stringify({ error: err }, null, 2);
}
