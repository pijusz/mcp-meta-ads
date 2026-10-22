#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadEnv, shouldValidateAtStartup } from "@/config/env";
import { createServer } from "@/server";
import { validateToken } from "@/services/meta-graph-api";
import { log } from "@/utils/logger";
import pkg from "../package.json";

export const VERSION = pkg.version;

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(`mcp-meta-ads v${VERSION}`);
  process.exit(0);
}

// "setup" is a help/diagnostics command (no OAuth flow needed; env-token only).
if (process.argv[2] === "setup") {
  printSetupHelp();
  process.exit(0);
}

const server = createServer();
const transport = new StdioServerTransport();

log.info(`Starting mcp-meta-ads v${VERSION} on stdio`);
await server.connect(transport);
void runStartupPreflight();

checkForUpdates();

async function runStartupPreflight() {
  try {
    const env = loadEnv();
    if (!env.META_ADS_ACCESS_TOKEN) {
      throw new Error("META_ADS_ACCESS_TOKEN is not set");
    }
    if (shouldValidateAtStartup()) {
      const me = await validateToken();
      log.info(`Token validated — user id ${me.id}${me.name ? ` (${me.name})` : ""}`);
    }
  } catch (err) {
    log.warn(
      "Startup preflight warning. MCP server is running, but tool calls may fail until this is fixed:",
      (err as Error).message,
    );
  }
}

function printSetupHelp(): void {
  console.log(`mcp-meta-ads v${VERSION} — setup

This server uses a Business Manager System User access token (no OAuth flow).

1) Open Business Manager → Business Settings → System Users → create a System User.
2) Assign the ad accounts you want to manage (with Admin access).
3) Add the 'ads_management' and 'ads_read' permissions.
4) Generate an access token; copy it.

Set the env var:

  export META_ADS_ACCESS_TOKEN=...

Then add this MCP to your client, e.g. Claude Code:

  claude mcp add meta-ads --scope user --transport stdio \\
    -e META_ADS_ACCESS_TOKEN=$META_ADS_ACCESS_TOKEN \\
    -- npx -y mcpj-meta-ads@latest

See README.md for the full env reference.
`);
}

function checkForUpdates() {
  if (typeof fetch !== "function") return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);

  fetch("https://api.github.com/repos/pijusz/mcp-meta-ads/releases/latest", {
    headers: { Accept: "application/vnd.github+json" },
    signal: controller.signal,
  })
    .then((res) => (res.ok ? res.json() : null))
    .then((data: { tag_name?: string } | null) => {
      if (!data?.tag_name) return;
      const latest = data.tag_name.replace(/^v/, "");
      if (isNewer(latest, VERSION)) {
        log.warn(
          `v${latest} available (current: v${VERSION}). Download: https://github.com/pijusz/mcp-meta-ads/releases/latest`,
        );
      }
    })
    .catch(() => {})
    .finally(() => clearTimeout(timer));
}

/** True when semver `a` is strictly greater than `b` (numeric x.y.z only). */
function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}
