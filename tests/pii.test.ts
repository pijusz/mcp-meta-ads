import { describe, expect, test } from "bun:test";
import {
  hashField,
  hashRow,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  normalizeZip,
} from "@/services/pii";

describe("pii normalization", () => {
  test("email: lowercase and trim", () => {
    expect(normalizeEmail("  John.Doe@Example.COM  ")).toBe("john.doe@example.com");
  });

  test("phone: digits only, strip leading zeros", () => {
    expect(normalizePhone("+1 (415) 555-1234")).toBe("14155551234");
    expect(normalizePhone("00 1 415 5551234")).toBe("14155551234");
  });

  test("name: lowercase, strip accents, strip whitespace", () => {
    expect(normalizeName("María Joséfa  ")).toBe("mariajosefa");
  });

  test("zip: US country truncates to first 5 chars", () => {
    expect(normalizeZip("94110-1234", "us")).toBe("94110");
    expect(normalizeZip("94110-1234", "US")).toBe("94110");
    expect(normalizeZip("94110", "us")).toBe("94110");
  });

  test("zip: non-US preserves full code, strips whitespace, lowercases", () => {
    expect(normalizeZip("SW1A 1AA", "gb")).toBe("sw1a1aa");
    expect(normalizeZip("M5V 3A8", "ca")).toBe("m5v3a8");
  });

  test("zip: unknown country does NOT truncate (preserves non-US 5-digit postcodes)", () => {
    // German postcode happens to be 5 digits — must not be confused with US ZIP.
    expect(normalizeZip("10115")).toBe("10115");
    // UK postcode with no country context: preserve.
    expect(normalizeZip("SW1A 1AA")).toBe("sw1a1aa");
  });
});

describe("hashField", () => {
  test("passes through already-hashed SHA256 values", () => {
    const alreadyHashed = "a".repeat(64);
    expect(hashField("EMAIL", alreadyHashed)).toBe(alreadyHashed);
  });

  test("hashes raw email after normalization", () => {
    // SHA256("john.doe@example.com")
    const expected = "836f82db99121b3481011f16b49dfa5fbc714a0d1b1b9f784a1ebbbf5b39577f";
    expect(hashField("EMAIL", " John.Doe@Example.COM ")).toBe(expected);
  });

  test("returns empty for empty input", () => {
    expect(hashField("EMAIL", "")).toBe("");
  });

  test("returns empty when input is whitespace-only (would normalize to '')", () => {
    // Regression: previously these passed the `if (!value)` check and got
    // hashed to SHA256("") = e3b0c442..., polluting audience uploads with a
    // canned identifier for blank fields.
    expect(hashField("EMAIL", "   ")).toBe("");
    expect(hashField("FN", "   ")).toBe("");
  });

  test("returns empty when name is punctuation-only (normalizes to '')", () => {
    expect(hashField("FN", "---")).toBe("");
    expect(hashField("LN", "...")).toBe("");
  });

  test("never returns SHA256 of empty string", () => {
    const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    for (const input of ["", "   ", "---", "\t\n"]) {
      expect(hashField("FN", input)).not.toBe(emptyHash);
    }
  });

  test("ZIP without context: does not truncate (avoids mangling non-US codes)", () => {
    // SHA256("10115") — German postcode kept whole.
    const expected = "ac7bb74de6884ffce919c15fef4193749d4588026c643973946713ac46da540d";
    // SHA256("1011") — what we'd get if we accidentally truncated.
    const truncated = "3dd9c0995d54c0abd51a90f1d57b1ce77bc885fc8a7cea52dcad3c2540dda5ee";
    const out = hashField("ZIP", "10115");
    expect(out).toBe(expected);
    expect(out).not.toBe(truncated);
  });

  test("ZIP with US context: truncates to 5 then hashes", () => {
    // Hash of "94110" (US ZIP truncated from 94110-1234) vs hash of "94110-1234".
    const truncated = hashField("ZIP", "94110-1234", { country: "us" });
    const untruncated = hashField("ZIP", "94110-1234");
    expect(truncated).not.toBe(untruncated);
  });
});

describe("hashRow", () => {
  test("threads COUNTRY context into ZIP normalization", () => {
    const schema = ["EMAIL", "ZIP", "COUNTRY"];
    const us = hashRow(schema, ["a@b.com", "94110-1234", "US"]);
    const gb = hashRow(schema, ["a@b.com", "SW1A 1AA", "GB"]);
    // ZIP hash differs from the no-context hash because of truncation.
    expect(us[1]).toBe(hashField("ZIP", "94110-1234", { country: "us" }));
    expect(gb[1]).toBe(hashField("ZIP", "SW1A 1AA", { country: "gb" }));
  });

  test("missing COUNTRY column → ZIP normalized without truncation", () => {
    const schema = ["EMAIL", "ZIP"];
    const hashed = hashRow(schema, ["a@b.com", "10115"]);
    expect(hashed[1]).toBe(hashField("ZIP", "10115"));
  });
});
