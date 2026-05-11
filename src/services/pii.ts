import { createHash } from "node:crypto";

/**
 * PII normalization + SHA256 hashing per Meta's customer file spec.
 *
 * Reference:
 *   https://developers.facebook.com/docs/marketing-api/audiences/guides/custom-audiences/#hash
 *   https://www.facebook.com/business/help/2082575038703844
 */

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

const ALREADY_HASHED = /^[a-f0-9]{64}$/i;

function isHashed(value: string): boolean {
  return ALREADY_HASHED.test(value);
}

function stripAccents(s: string): string {
  // Strip Unicode combining marks (U+0300 – U+036F).
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizePhone(value: string): string {
  // Digits only, retain country code, strip leading + and zeros.
  return value.replace(/\D/g, "").replace(/^0+/, "");
}

export function normalizeName(value: string): string {
  // Lowercase, strip accents, strip whitespace and punctuation.
  return stripAccents(value)
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

export function normalizeDob(value: string): string {
  // Expect "YYYY-MM-DD" or similar; output "YYYYMMDD".
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 8) {
    throw new Error(`Invalid DOB ${value} — expected YYYY-MM-DD`);
  }
  return digits;
}

export function normalizeCity(value: string): string {
  return stripAccents(value)
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

export function normalizeState(value: string): string {
  // Meta wants 2-letter code, lowercase. We don't try to validate the code itself.
  return value.trim().toLowerCase();
}

/**
 * Postal-code normalization.
 *
 * Meta spec: first 5 chars for US ZIPs (handles ZIP+4 like "94110-1234"); for
 * non-US countries lowercase the whole code with whitespace stripped. We never
 * truncate when country is unknown to avoid mangling 5-digit-numeric postcodes
 * that aren't US (e.g. German `10115`).
 */
export function normalizeZip(value: string, country?: string): string {
  const cleaned = value.trim().toLowerCase().replace(/\s+/g, "");
  const isUs = country?.trim().toLowerCase() === "us";
  if (isUs) {
    return cleaned.slice(0, 5);
  }
  return cleaned;
}

export function normalizeCountry(value: string): string {
  // 2-letter ISO, lowercase.
  return value.trim().toLowerCase().slice(0, 2);
}

export function normalizeGender(value: string): string {
  const v = value.trim().toLowerCase();
  if (v.startsWith("m")) return "m";
  if (v.startsWith("f")) return "f";
  throw new Error(`Invalid gender ${value} — expected m/f`);
}

export function normalizeMadid(value: string): string {
  return value.trim().toLowerCase();
}

type Normalizer = (v: string) => string;

const NORMALIZERS: Record<string, Normalizer> = {
  EMAIL: normalizeEmail,
  PHONE: normalizePhone,
  FN: normalizeName,
  LN: normalizeName,
  DOB: normalizeDob,
  CT: normalizeCity,
  ST: normalizeState,
  // ZIP is country-aware and dispatched directly in hashField.
  COUNTRY: normalizeCountry,
  GEN: normalizeGender,
  MADID: normalizeMadid,
};

export interface HashContext {
  /** 2-letter ISO country code, lowercase. Used by ZIP/postal normalization. */
  country?: string;
}

/**
 * Hash a single field value if not already hashed.
 * `fieldType` is Meta's schema key (EMAIL, PHONE, FN, LN, ZIP, ...).
 *
 * Returns "" for inputs that are blank before *or after* normalization — we
 * must never upload SHA256("") (the well-known empty-string digest) as a
 * real identifier, since Meta would treat it as a valid hash and dilute
 * the audience match rate.
 */
export function hashField(
  fieldType: string,
  value: string,
  context?: HashContext,
): string {
  if (!value) return "";
  if (isHashed(value)) return value.toLowerCase();

  let normalized: string;
  if (fieldType === "ZIP") {
    normalized = normalizeZip(value, context?.country);
  } else {
    const normalizer = NORMALIZERS[fieldType];
    normalized = normalizer
      ? normalizer(value)
      : // Unknown field — best-effort: trim + lowercase.
        value.trim().toLowerCase();
  }

  // Inputs like "   ", "---", non-Latin-only names, or "0000" can survive the
  // initial truthy check but normalize to empty. Bail before hashing those.
  if (!normalized) return "";

  return sha256Hex(normalized);
}

/**
 * Hash an entire row (array aligned to a schema array).
 * Extracts COUNTRY from the row (if present) and threads it as context so
 * ZIP/postal normalization can branch on US vs. non-US.
 *
 * Example: schema = ["EMAIL","PHONE","FN"], row = ["a@b.com", "+1 555", "John"]
 */
export function hashRow(schema: string[], row: string[]): string[] {
  const countryIdx = schema.indexOf("COUNTRY");
  const rawCountry = countryIdx >= 0 ? row[countryIdx] : undefined;
  const country = rawCountry ? normalizeCountry(rawCountry) : undefined;
  const context: HashContext | undefined = country ? { country } : undefined;
  return schema.map((field, i) => hashField(field, row[i] ?? "", context));
}
