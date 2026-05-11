/**
 * Normalize a Meta ad-account ID. Accepts "123" or "act_123" and returns "act_123".
 *
 * Throws if the input is not a non-empty digit string (with optional `act_` prefix).
 */
export function normalizeActId(input: string | number): string {
  const raw = String(input).trim();
  if (!raw) {
    throw new Error("Account ID is required");
  }
  const stripped = raw.startsWith("act_") ? raw.slice(4) : raw;
  if (!/^\d+$/.test(stripped)) {
    throw new Error(
      `Invalid Meta ad-account ID: ${raw} (expected digits, with optional "act_" prefix)`,
    );
  }
  return `act_${stripped}`;
}

/**
 * Return just the numeric part of an account ID (no `act_` prefix).
 */
export function actIdNumeric(input: string | number): string {
  return normalizeActId(input).slice(4);
}
