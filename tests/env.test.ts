import { describe, expect, test } from "bun:test";
import { parseEnvLine } from "@/config/env";

describe("parseEnvLine", () => {
  test("returns null for empty lines", () => {
    expect(parseEnvLine("")).toBeNull();
    expect(parseEnvLine("   ")).toBeNull();
  });

  test("returns null for full-line comments", () => {
    expect(parseEnvLine("# a comment")).toBeNull();
    expect(parseEnvLine("   # indented comment")).toBeNull();
  });

  test("returns null for malformed lines (no '=' or empty key)", () => {
    expect(parseEnvLine("just_a_key_no_equals")).toBeNull();
    expect(parseEnvLine("=value-without-key")).toBeNull();
  });

  test("parses a basic KEY=value pair", () => {
    expect(parseEnvLine("FOO=bar")).toEqual({ key: "FOO", value: "bar" });
  });

  test("strips leading 'export '", () => {
    expect(parseEnvLine("export FOO=bar")).toEqual({ key: "FOO", value: "bar" });
  });

  test("strips balanced double quotes around value", () => {
    expect(parseEnvLine('FOO="quoted value"')).toEqual({
      key: "FOO",
      value: "quoted value",
    });
  });

  test("strips balanced single quotes around value", () => {
    expect(parseEnvLine("FOO='single quoted'")).toEqual({
      key: "FOO",
      value: "single quoted",
    });
  });

  test("preserves quotes inside an unquoted value (mismatched)", () => {
    expect(parseEnvLine('FOO=has"middle"quote')).toEqual({
      key: "FOO",
      value: 'has"middle"quote',
    });
  });

  test("strips trailing inline comment on unquoted values", () => {
    expect(parseEnvLine("FOO=bar  # inline comment")).toEqual({
      key: "FOO",
      value: "bar",
    });
  });

  test("preserves '#' inside quoted values (no comment stripping)", () => {
    expect(parseEnvLine('FOO="value with # hash"')).toEqual({
      key: "FOO",
      value: "value with # hash",
    });
  });

  test("converts literal \\n sequences to real newlines", () => {
    expect(parseEnvLine("MULTI=line1\\nline2")).toEqual({
      key: "MULTI",
      value: "line1\nline2",
    });
  });

  test("splits on the FIRST '=' only", () => {
    expect(parseEnvLine("URL=https://example.com/path?key=value")).toEqual({
      key: "URL",
      value: "https://example.com/path?key=value",
    });
  });

  test("trims whitespace around key + value", () => {
    expect(parseEnvLine("  KEY  =  value  ")).toEqual({
      key: "KEY",
      value: "value",
    });
  });
});
