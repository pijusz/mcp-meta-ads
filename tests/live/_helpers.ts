import { graphFetch } from "@/services/meta-graph-api";
import { normalizeActId } from "@/utils/account-id";
import { MetaApiError } from "@/utils/errors";

/**
 * Helpers for live integration tests that hit the real Meta Graph API.
 *
 * Guard contract:
 *   - `META_ADS_RUN_LIVE_TESTS=true` is required (explicit opt-in)
 *   - `META_ADS_ACCESS_TOKEN` must be set (read from .env)
 *   - `META_ADS_TEST_ACCOUNT_ID` must be set — the account these tests target.
 *     Never falls back to the first account on the user's list; we don't want
 *     test campaigns landing in production by accident.
 *
 * Cleanup contract:
 *   - Every entity created during a test is registered via `track*()`.
 *   - The `cleanupTracked()` helper deletes them all in afterEach.
 *   - 404s (object already deleted by the test itself) are swallowed.
 *   - All test entity names are prefixed `mcp-meta-ads-test-` for a fallback
 *     `scripts/cleanup-test-entities.ts` script.
 */

export const TEST_NAME_PREFIX = "mcp-meta-ads-test-";

export function liveTestsEnabled(): boolean {
  return (
    process.env.META_ADS_RUN_LIVE_TESTS === "true" &&
    !!process.env.META_ADS_ACCESS_TOKEN &&
    !!process.env.META_ADS_TEST_ACCOUNT_ID
  );
}

export function liveSkipReason(): string {
  if (process.env.META_ADS_RUN_LIVE_TESTS !== "true") {
    return "META_ADS_RUN_LIVE_TESTS != true";
  }
  if (!process.env.META_ADS_ACCESS_TOKEN) {
    return "META_ADS_ACCESS_TOKEN not set";
  }
  if (!process.env.META_ADS_TEST_ACCOUNT_ID) {
    return "META_ADS_TEST_ACCOUNT_ID not set";
  }
  return "(enabled)";
}

/**
 * Additional gate for tests that require the test ad account to be attached
 * to a Meta Business. Specifically: customer-list custom audiences require
 * `business`-attached accounts; standalone sandbox accounts get a 200/1870050
 * error ("Business Account Needed to Create/Edit This Audience").
 *
 * Sandbox test accounts are not auto-attached to a business — operator must
 * either move the test account into a BM (Business Settings → Accounts →
 * Ad Accounts → Add → "I own") or accept that audience tests will skip.
 */
export function liveBusinessAttachedTestsEnabled(): boolean {
  return liveTestsEnabled() && process.env.META_ADS_TEST_BUSINESS_ATTACHED === "true";
}

export function liveBusinessAttachedSkipReason(): string {
  if (!liveTestsEnabled()) return liveSkipReason();
  if (process.env.META_ADS_TEST_BUSINESS_ATTACHED !== "true") {
    return "META_ADS_TEST_BUSINESS_ATTACHED != true (audience tests need a BM-attached account)";
  }
  return "(enabled)";
}

export function getTestAccountId(): string {
  const raw = process.env.META_ADS_TEST_ACCOUNT_ID;
  if (!raw) {
    throw new Error(
      "META_ADS_TEST_ACCOUNT_ID is required for live tests. Set to an ad account ID (with or without 'act_' prefix) that is safe to mutate.",
    );
  }
  return normalizeActId(raw);
}

/**
 * Generate a unique entity name with the test prefix.
 * Example: testName("campaign") → "mcp-meta-ads-test-campaign-2026-05-11T14-32-15-123Z-a8f7c2"
 */
export function testName(suffix: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${TEST_NAME_PREFIX}${suffix}-${timestamp}-${rand}`;
}

/**
 * Per-test-file registry of entity IDs to delete at teardown.
 * Each test file gets its own instance via createRegistry().
 */
export interface CleanupRegistry {
  trackCampaign(id: string): void;
  trackAdSet(id: string): void;
  trackAd(id: string): void;
  trackCreative(id: string): void;
  trackAudience(id: string): void;
  cleanup(): Promise<{ deleted: number; failed: number }>;
}

export function createRegistry(): CleanupRegistry {
  const ids = {
    campaigns: new Set<string>(),
    adsets: new Set<string>(),
    ads: new Set<string>(),
    creatives: new Set<string>(),
    audiences: new Set<string>(),
  };

  async function safeDelete(id: string): Promise<boolean> {
    try {
      await graphFetch<{ success?: boolean }>(id, { method: "DELETE" });
      return true;
    } catch (err) {
      // 100:33 = "object doesn't exist" — already deleted by the test itself.
      if (err instanceof MetaApiError && err.code === 100 && err.subcode === 33) {
        return true;
      }
      console.error(`[cleanup] failed to delete ${id}:`, (err as Error).message);
      return false;
    }
  }

  return {
    trackCampaign: (id) => ids.campaigns.add(id),
    trackAdSet: (id) => ids.adsets.add(id),
    trackAd: (id) => ids.ads.add(id),
    trackCreative: (id) => ids.creatives.add(id),
    trackAudience: (id) => ids.audiences.add(id),
    async cleanup() {
      let deleted = 0;
      let failed = 0;
      // Order matters: ads → adsets → campaigns; creatives last; audiences any time.
      const ordered = [
        ...ids.ads,
        ...ids.adsets,
        ...ids.campaigns,
        ...ids.creatives,
        ...ids.audiences,
      ];
      for (const id of ordered) {
        const ok = await safeDelete(id);
        if (ok) deleted++;
        else failed++;
      }
      ids.campaigns.clear();
      ids.adsets.clear();
      ids.ads.clear();
      ids.creatives.clear();
      ids.audiences.clear();
      return { deleted, failed };
    },
  };
}
