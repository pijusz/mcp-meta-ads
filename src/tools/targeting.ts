import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { graphFetch } from "@/services/meta-graph-api";
import { readTool } from "@/utils/register-tool";
import { fail, ok } from "@/utils/tool-response";

/**
 * Targeting helpers — wraps Meta's `/search` endpoint family + a builder that
 * assembles a Meta-shaped `targeting` object from human concepts.
 *
 * Per SPEC.md decision #12, builder helpers do interest-name lookups
 * internally so callers can pass `interests: ['fitness']` instead of FB IDs.
 */

const GENDER_MAP: Record<string, number> = { male: 1, female: 2, all: 0 };

interface InterestResult {
  id: string;
  name: string;
  audience_size_lower_bound?: number;
  audience_size_upper_bound?: number;
  path?: string[];
  description?: string;
  topic?: string;
}

interface GeoResult {
  key: string;
  name: string;
  type: string;
  country_code?: string;
  country_name?: string;
  region?: string;
  region_id?: string;
  supports_region?: boolean;
  supports_city?: boolean;
}

interface BehaviorResult {
  id: string;
  name: string;
  audience_size_lower_bound?: number;
  audience_size_upper_bound?: number;
  path?: string[];
  type?: string;
}

interface SearchEnvelope<T> {
  data?: T[];
}

export function registerTargetingTools(server: McpServer): void {
  readTool(
    server,
    "search_interests",
    `Search Meta's ad-interest catalog. Returns interest IDs you reference inside a targeting spec.

The interest taxonomy was pruned in March 2025 (sensitive-category restrictions); many older IDs return zero results. Always call this before using interest IDs.`,
    {
      query: z
        .string()
        .min(1)
        .describe("Free-text search term, e.g. 'fitness', 'cooking'."),
      limit: z.number().int().min(1).max(100).default(25),
      locale: z.string().default("en_US").describe("Result locale, e.g. en_US, lt_LT."),
    },
    async ({ query, limit, locale }) => {
      try {
        const res = await graphFetch<SearchEnvelope<InterestResult>>("search", {
          params: { type: "adinterest", q: query, limit, locale },
        });
        return ok({ data: res.data ?? [] });
      } catch (err) {
        return fail(err);
      }
    },
  );

  readTool(
    server,
    "search_geo_locations",
    `Search Meta's geo-targeting catalog (countries, regions, cities, zips, geo_markets, electoral districts).

Returns 'key' values which you pass into a targeting spec's geo_locations[type] array — the key is what Meta expects, not the display name.`,
    {
      query: z.string().min(1),
      types: z
        .array(
          z.enum([
            "country",
            "country_group",
            "region",
            "city",
            "zip",
            "geo_market",
            "electoral_district",
            "subcity",
            "neighborhood",
            "small_geo_area",
            "medium_geo_area",
            "large_geo_area",
            "metro_area",
          ]),
        )
        .optional()
        .describe("Filter to specific geo types. Default: all."),
      limit: z.number().int().min(1).max(100).default(25),
      locale: z.string().default("en_US"),
    },
    async ({ query, types, limit, locale }) => {
      try {
        const params: Record<string, string | number> = {
          type: "adgeolocation",
          q: query,
          limit,
          locale,
        };
        if (types?.length) params.location_types = JSON.stringify(types);
        const res = await graphFetch<SearchEnvelope<GeoResult>>("search", { params });
        return ok({ data: res.data ?? [] });
      } catch (err) {
        return fail(err);
      }
    },
  );

  readTool(
    server,
    "search_behaviors",
    `List Meta's behavioral targeting categories. Unlike interests, behaviors are typically browsed (not searched by name) — pass query='' to list all.`,
    {
      query: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(50),
    },
    async ({ query, limit }) => {
      try {
        const params: Record<string, string | number> = {
          type: "adTargetingCategory",
          class: "behaviors",
          limit,
        };
        if (query) params.q = query;
        const res = await graphFetch<SearchEnvelope<BehaviorResult>>("search", {
          params,
        });
        return ok({ data: res.data ?? [] });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // build_targeting does no mutations — it just looks up names and assembles a
  // spec. Use readTool so MCP clients don't render a destructive-write prompt.
  // Strictly speaking, idempotency could flicker as Meta's interest taxonomy
  // shifts under us, but the same caveat applies to the search_* tools and
  // matches industry convention for read-side helpers.
  readTool(
    server,
    "build_targeting",
    `Build a Meta targeting JSON spec from human-readable concepts.

Resolves interest / behavior names to Meta IDs via internal calls to search_interests / search_behaviors. Returns the spec — does NOT call any mutation endpoint; the caller passes the result into create_adset / update_adset.

Always also accepts pre-resolved IDs (interest_ids, behavior_ids) to skip the lookups for known values.`,
    {
      countries: z
        .array(z.string().length(2))
        .optional()
        .describe("2-letter ISO codes, e.g. ['US', 'CA']."),
      regions: z
        .array(z.string())
        .optional()
        .describe(
          "Region keys (resolve via search_geo_locations first). Use country-relative codes.",
        ),
      cities: z
        .array(z.string())
        .optional()
        .describe("City keys from search_geo_locations."),
      age_min: z.number().int().min(13).max(65).optional(),
      age_max: z.number().int().min(13).max(65).optional(),
      genders: z
        .array(z.enum(["male", "female", "all"]))
        .optional()
        .describe("'all' is equivalent to omitting; defaults to no restriction."),
      interests: z
        .array(z.string())
        .optional()
        .describe("Interest names — server resolves via search_interests."),
      interest_ids: z
        .array(z.string())
        .optional()
        .describe("Pre-resolved interest IDs (skips lookup)."),
      behaviors: z
        .array(z.string())
        .optional()
        .describe("Behavior names — server resolves via search_behaviors."),
      behavior_ids: z.array(z.string()).optional(),
      custom_audiences: z
        .array(z.string())
        .optional()
        .describe("Audience IDs to include."),
      exclude_custom_audiences: z
        .array(z.string())
        .optional()
        .describe("Audience IDs to exclude."),
      device_platforms: z.array(z.enum(["mobile", "desktop", "connected_tv"])).optional(),
      publisher_platforms: z
        .array(z.enum(["facebook", "instagram", "messenger", "audience_network"]))
        .optional(),
      locale: z.string().default("en_US"),
    },
    async (args) => {
      try {
        // Resolve interest names → IDs
        const interestIds: Array<{ id: string; name: string }> = [];
        for (const id of args.interest_ids ?? []) {
          interestIds.push({ id, name: id });
        }
        for (const name of args.interests ?? []) {
          const res = await graphFetch<SearchEnvelope<InterestResult>>("search", {
            params: { type: "adinterest", q: name, limit: 1, locale: args.locale },
          });
          const first = res.data?.[0];
          if (first) interestIds.push({ id: first.id, name: first.name });
        }

        // Resolve behavior names → IDs
        const behaviorIds: Array<{ id: string; name: string }> = [];
        for (const id of args.behavior_ids ?? []) {
          behaviorIds.push({ id, name: id });
        }
        for (const name of args.behaviors ?? []) {
          const res = await graphFetch<SearchEnvelope<BehaviorResult>>("search", {
            params: {
              type: "adTargetingCategory",
              class: "behaviors",
              q: name,
              limit: 1,
            },
          });
          const first = res.data?.[0];
          if (first) behaviorIds.push({ id: first.id, name: first.name });
        }

        const spec = assembleTargeting({
          countries: args.countries,
          regions: args.regions,
          cities: args.cities,
          age_min: args.age_min,
          age_max: args.age_max,
          genders: args.genders,
          interests: interestIds,
          behaviors: behaviorIds,
          custom_audiences: args.custom_audiences,
          exclude_custom_audiences: args.exclude_custom_audiences,
          device_platforms: args.device_platforms,
          publisher_platforms: args.publisher_platforms,
        });
        return ok({ targeting: spec });
      } catch (err) {
        return fail(err);
      }
    },
  );
}

/**
 * Pure-function spec assembly. Exported for unit testing.
 */
export interface BuildTargetingInput {
  countries?: string[];
  regions?: string[];
  cities?: string[];
  age_min?: number;
  age_max?: number;
  genders?: Array<"male" | "female" | "all">;
  interests?: Array<{ id: string; name: string }>;
  behaviors?: Array<{ id: string; name: string }>;
  custom_audiences?: string[];
  exclude_custom_audiences?: string[];
  device_platforms?: string[];
  publisher_platforms?: string[];
}

export function assembleTargeting(input: BuildTargetingInput): Record<string, unknown> {
  const spec: Record<string, unknown> = {};

  // geo_locations
  const geo: Record<string, unknown> = {};
  if (input.countries?.length) geo.countries = input.countries;
  if (input.regions?.length) geo.regions = input.regions.map((key) => ({ key }));
  if (input.cities?.length) geo.cities = input.cities.map((key) => ({ key }));
  if (Object.keys(geo).length > 0) spec.geo_locations = geo;

  if (input.age_min !== undefined) spec.age_min = input.age_min;
  if (input.age_max !== undefined) spec.age_max = input.age_max;

  // genders: 1=male, 2=female; omit if 'all' or unset
  if (input.genders?.length) {
    const nums = input.genders
      .filter((g) => g !== "all")
      .map((g) => GENDER_MAP[g])
      .filter((n): n is number => n > 0);
    if (nums.length > 0) spec.genders = nums;
  }

  // flexible_spec — each entry is AND'd within, OR'd across the array.
  // For our builder, one entry containing both interests and behaviors is the
  // most common shape (people who match ANY listed interest AND ANY behavior).
  const flexible: Record<string, unknown> = {};
  if (input.interests?.length) {
    flexible.interests = input.interests.map((i) => ({ id: i.id, name: i.name }));
  }
  if (input.behaviors?.length) {
    flexible.behaviors = input.behaviors.map((b) => ({ id: b.id, name: b.name }));
  }
  if (Object.keys(flexible).length > 0) spec.flexible_spec = [flexible];

  if (input.custom_audiences?.length) {
    spec.custom_audiences = input.custom_audiences.map((id) => ({ id }));
  }
  if (input.exclude_custom_audiences?.length) {
    spec.excluded_custom_audiences = input.exclude_custom_audiences.map((id) => ({
      id,
    }));
  }

  if (input.device_platforms?.length) spec.device_platforms = input.device_platforms;
  if (input.publisher_platforms?.length) {
    spec.publisher_platforms = input.publisher_platforms;
  }

  return spec;
}
