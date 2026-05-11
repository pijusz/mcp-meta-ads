#!/usr/bin/env bun
/**
 * Find or create a Meta test ad account for live integration testing.
 *
 * Test ad accounts:
 *   - Live ad account objects, scoped to a Meta App
 *   - Max 15 per app
 *   - Run against the real Marketing API surface but cannot serve real ads
 *   - Cannot spend money — even if a test creative were live, no impressions
 *
 * Usage:
 *   # Required env (in .env):
 *   META_ADS_ACCESS_TOKEN=<system user token>
 *   META_ADS_APP_ID=<your meta app id>
 *
 *   bun scripts/create-test-account.ts
 *
 * Behavior:
 *   1. Loads .env
 *   2. Lists existing test ad accounts on the app (`GET /<APP_ID>/owned_adaccounts?fields=...`)
 *   3. If one with name "mcp-meta-ads-test-account" exists → reuses it
 *   4. Otherwise creates one with that name (currency USD, timezone UTC)
 *   5. Prints the account ID + suggested line for .env
 */
import { loadEnv } from "@/config/env";
import { graphFetch } from "@/services/meta-graph-api";
import { MetaApiError } from "@/utils/errors";

const TEST_ACCOUNT_NAME = "mcp-meta-ads-test-account";
const CURRENCY = "USD";
const TIMEZONE_ID = 0; // 0 = UTC

interface AccountInfo {
  id: string;
  account_id?: string;
  name?: string;
  account_status?: number;
  currency?: string;
  is_test_account?: boolean;
}

interface AccountList {
  data?: AccountInfo[];
  paging?: { cursors?: { after?: string }; next?: string };
}

async function findExisting(appId: string): Promise<AccountInfo | null> {
  // Meta exposes a test-ad-account list under multiple edges depending on
  // app config. `owned_ad_accounts` returns all owned accounts but might
  // filter out test ones; `adaccounts` typically includes test accounts.
  // We check BOTH edges before deciding nothing exists — otherwise we'd
  // create a duplicate if the first edge returned a list without our match.
  const candidates = [`${appId}/owned_ad_accounts`, `${appId}/adaccounts`];
  for (const edge of candidates) {
    try {
      const res = await graphFetch<AccountList>(edge, {
        params: {
          fields: "id,account_id,name,account_status,currency,is_test_account",
          limit: 100,
        },
      });
      const match = (res.data ?? []).find(
        (a) => a.name === TEST_ACCOUNT_NAME && a.is_test_account !== false,
      );
      if (match) return match;
      // No match on this edge — keep trying the others.
    } catch (err) {
      // Edge not available on this app/version; try the next one.
      if (err instanceof MetaApiError && err.code === 100) continue;
      throw err;
    }
  }
  return null;
}

async function createTestAccount(appId: string): Promise<AccountInfo> {
  // POST /<APP_ID>/adaccounts is the canonical endpoint for app-owned ad accounts.
  // For dev-mode apps, accounts created here are test ad accounts.
  // Required fields per Meta docs:
  //   - name
  //   - currency
  //   - timezone_id
  //   - end_advertiser=NONE (or business ID)
  //   - media_agency=NONE
  //   - partner=NONE
  try {
    const created = await graphFetch<{ id: string }>(`${appId}/adaccounts`, {
      method: "POST",
      body: {
        name: TEST_ACCOUNT_NAME,
        currency: CURRENCY,
        timezone_id: TIMEZONE_ID,
        end_advertiser: "NONE",
        media_agency: "NONE",
        partner: "NONE",
      },
    });
    return created;
  } catch (err) {
    if (err instanceof MetaApiError) {
      console.error(
        `\n  ✗ create failed: code=${err.code ?? "-"} subcode=${err.subcode ?? "-"}`,
      );
      console.error(`    message: ${err.message}`);
      if (err.hint) console.error(`    hint: ${err.hint}`);
      if (err.code === 200 || err.code === 10 || err.code === 294) {
        console.error(
          `\n  Permission denied. Two common causes:\n` +
            `    1. Token lacks the right scope. System User tokens often can't create ad accounts.\n` +
            `       Try a personal user access token from Graph API Explorer with 'ads_management' instead.\n` +
            `    2. App is missing the Marketing API product. Add it at\n` +
            `       https://developers.facebook.com/apps/${appId}/products/\n` +
            `\n  Fallback: create a test ad account in the Meta developer dashboard UI:\n` +
            `    https://developers.facebook.com/apps/${appId}/marketing-api/tools/\n`,
        );
      }
    }
    throw err;
  }
}

async function main() {
  loadEnv();
  const appId = process.env.META_ADS_APP_ID;
  if (!appId) {
    console.error(
      "META_ADS_APP_ID is required. Set it in .env (find it at developers.facebook.com → your app → Settings → Basic).",
    );
    process.exit(1);
  }

  console.log(`▸ Looking for existing test ad account on app ${appId}...`);
  const existing = await findExisting(appId);
  let account: AccountInfo;
  if (existing) {
    console.log(`  ✓ found existing: ${existing.id} "${existing.name}"`);
    account = existing;
  } else {
    console.log(`  (no match)`);
    console.log(`▸ Creating test ad account "${TEST_ACCOUNT_NAME}"...`);
    account = await createTestAccount(appId);
    console.log(`  ✓ created: ${account.id}`);
  }

  // Normalize to act_<id>. The /adaccounts response may return either `id` or
  // `account_id`; the canonical form is `act_<id>`.
  const actId = account.id.startsWith("act_") ? account.id : `act_${account.id}`;

  console.log("\n" + "─".repeat(60));
  console.log(`Test ad account: ${actId}`);
  console.log("Add this line to .env to enable live tests:");
  console.log(`\n  META_ADS_TEST_ACCOUNT_ID=${actId}\n`);
  console.log("Then run:");
  console.log(`  bun run test:live\n`);
}

await main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
