#!/usr/bin/env bun
/**
 * Fallback cleanup script — finds and deletes any leftover test entities
 * in META_ADS_TEST_ACCOUNT_ID whose names start with `mcp-meta-ads-test-`.
 *
 * Use this if a live-test run crashed mid-flight and left orphans behind.
 *
 * Usage:
 *   META_ADS_TEST_ACCOUNT_ID=act_X bun scripts/cleanup-test-entities.ts
 *   META_ADS_TEST_ACCOUNT_ID=act_X bun scripts/cleanup-test-entities.ts --dry-run
 */
import { loadEnv } from "@/config/env";
import { graphFetch, graphPaginate } from "@/services/meta-graph-api";
import { normalizeActId } from "@/utils/account-id";
import { MetaApiError } from "@/utils/errors";
import { TEST_NAME_PREFIX } from "../tests/live/_helpers";

const DRY_RUN = process.argv.includes("--dry-run");

interface NamedEntity {
  id: string;
  name?: string;
  status?: string;
}

async function listMatching(edge: string, actId: string): Promise<NamedEntity[]> {
  const found: NamedEntity[] = [];
  let cursor: string | undefined;
  for (let safety = 0; safety < 20; safety++) {
    const page = await graphPaginate<NamedEntity>(`${actId}/${edge}`, {
      params: { fields: "id,name,status", limit: 100, ...(cursor ? { cursor } : {}) },
    });
    for (const entity of page.data) {
      if (entity.name?.startsWith(TEST_NAME_PREFIX)) found.push(entity);
    }
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }
  return found;
}

async function deleteSafely(id: string): Promise<boolean> {
  try {
    await graphFetch<{ success?: boolean }>(id, { method: "DELETE" });
    return true;
  } catch (err) {
    if (err instanceof MetaApiError && err.code === 100 && err.subcode === 33) {
      return true; // already gone
    }
    console.error(`  ✗ failed to delete ${id}: ${(err as Error).message}`);
    return false;
  }
}

async function main() {
  loadEnv();
  const actId = normalizeActId(
    process.env.META_ADS_TEST_ACCOUNT_ID ??
      (() => {
        throw new Error(
          "META_ADS_TEST_ACCOUNT_ID is required. Set to the test ad account ID.",
        );
      })(),
  );

  console.log(
    `Scanning ${actId} for test entities with prefix "${TEST_NAME_PREFIX}"...`,
  );
  if (DRY_RUN) console.log("(dry-run mode — nothing will be deleted)");

  // Order matters: ads → adsets → campaigns (Meta auto-deletes children when
  // a parent is deleted, but we list/delete explicitly so cleanup output is
  // accurate). adcreatives + customaudiences are independent edges.
  const edges = [
    "ads",
    "adsets",
    "campaigns",
    "adcreatives",
    "customaudiences",
  ] as const;
  let totalFound = 0;
  let totalDeleted = 0;

  for (const edge of edges) {
    const items = await listMatching(edge, actId);
    if (items.length === 0) {
      console.log(`  ${edge}: 0 matches`);
      continue;
    }
    console.log(`  ${edge}: ${items.length} match(es)`);
    totalFound += items.length;
    for (const item of items) {
      const label = `${item.id} "${item.name}"`;
      if (DRY_RUN) {
        console.log(`    would delete: ${label}`);
        continue;
      }
      const ok = await deleteSafely(item.id);
      if (ok) {
        console.log(`    ✓ deleted ${label}`);
        totalDeleted++;
      }
    }
  }

  console.log(
    `\nDone. ${totalFound} matched, ${DRY_RUN ? 0 : totalDeleted} deleted, ${totalFound - totalDeleted - (DRY_RUN ? totalFound : 0)} failed.`,
  );
}

await main();
