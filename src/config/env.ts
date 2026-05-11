import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

const envSchema = z.object({
  META_ADS_ACCESS_TOKEN: z.string().min(1, "META_ADS_ACCESS_TOKEN is required"),
  META_ADS_APP_SECRET: z.string().default(""),
  META_GRAPH_API_VERSION: z.string().default("v23.0"),
  META_ADS_VALIDATE_AT_STARTUP: z.enum(["true", "false"]).default("false"),
  META_ADS_RATE_LIMIT_THRESHOLD: z.coerce.number().int().min(0).max(100).default(75),
  META_ADS_DEFAULT_PAGE_SIZE: z.coerce.number().int().min(1).max(100).default(25),
  META_ADS_INSIGHTS_ASYNC_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120_000),
  META_ADS_INSIGHTS_ASYNC_POLL_MS: z.coerce.number().int().min(250).default(2000),
  META_ADS_LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).default("warn"),
  META_ADS_REQUIRE_PREHASHED: z.enum(["true", "false"]).default("false"),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;
let _dotenvLoaded = false;

function loadDotEnvIfPresent(): void {
  if (_dotenvLoaded) return;
  _dotenvLoaded = true;

  const envFile = process.env.META_ADS_ENV_FILE || ".env";
  if (!existsSync(envFile)) return;

  let text: string;
  try {
    text = readFileSync(envFile, "utf-8");
  } catch {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const withoutExport = line.startsWith("export ")
      ? line.slice("export ".length).trim()
      : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!key) continue;
    if (process.env[key] !== undefined) continue;

    let value = withoutExport.slice(eq + 1).trim();
    const hasQuotes =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (hasQuotes && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    process.env[key] = value.replace(/\\n/g, "\n");
  }
}

function formatEnvError(err: z.ZodError): string {
  const lines = err.issues.map((issue) => {
    const key = issue.path.join(".") || "unknown";
    return `- ${key}: ${issue.message}`;
  });
  return `Invalid environment configuration:\n${lines.join("\n")}`;
}

export function loadEnv(): Env {
  if (_env) return _env;
  loadDotEnvIfPresent();
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(formatEnvError(parsed.error));
  }
  _env = parsed.data;
  return _env;
}

export function getEnv(): Env {
  if (!_env) return loadEnv();
  return _env;
}

export function shouldValidateAtStartup(): boolean {
  return process.env.META_ADS_VALIDATE_AT_STARTUP === "true";
}

export function requirePrehashed(): boolean {
  return process.env.META_ADS_REQUIRE_PREHASHED === "true";
}
