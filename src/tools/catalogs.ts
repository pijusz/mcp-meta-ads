import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { graphFetch } from "@/services/meta-graph-api";
import { normalizeActId } from "@/utils/account-id";
import { readTool, writeTool } from "@/utils/register-tool";
import { fail, ok } from "@/utils/tool-response";

/**
 * Product catalog tools — for Dynamic Product Ads (DPA) and Advantage+ Catalog Ads.
 *
 * Catalogs live under a Business Manager, not an ad account. The token must
 * have business_management permission on the BM that owns the catalog.
 *
 * v24+ behavior (docs/RESEARCH.md §2.7):
 *   - allow_upsert: true gives create-or-update semantics on bulk product writes
 *   - Items Batch payload cap: 30 MB per request, 5,000 items per request
 */

const ITEM_METHOD = z.enum(["CREATE", "UPDATE", "DELETE"]);

interface CatalogCreateResponse {
  id: string;
}

interface ProductSetCreateResponse {
  id: string;
}

interface ItemsBatchResponse {
  handles?: string[];
  validation_status?: { errors?: unknown[]; warnings?: unknown[] };
}

const ITEMS_BATCH_HARD_CAP_BYTES = 30 * 1024 * 1024;
const ITEMS_BATCH_HARD_CAP_ROWS = 5_000;

export function registerCatalogTools(server: McpServer): void {
  readTool(
    server,
    "list_catalogs",
    "List product catalogs owned by a Business Manager. Requires business_management permission on the BM.",
    {
      business_id: z.string().describe("Business Manager ID."),
      limit: z.number().int().min(1).max(100).default(50),
    },
    async ({ business_id, limit }) => {
      try {
        const res = await graphFetch<{
          data?: Array<Record<string, unknown>>;
          paging?: { cursors?: { after?: string }; next?: string };
        }>(`${business_id}/owned_product_catalogs`, {
          params: {
            fields: "id,name,vertical,product_count,store_catalog_settings",
            limit,
          },
        });
        return ok({ data: res.data ?? [] });
      } catch (err) {
        return fail(err);
      }
    },
  );

  readTool(
    server,
    "list_product_sets",
    "List product sets inside a catalog. Product sets are subsets of the catalog used to target specific products in DPA.",
    {
      catalog_id: z.string(),
      limit: z.number().int().min(1).max(100).default(50),
    },
    async ({ catalog_id, limit }) => {
      try {
        const res = await graphFetch<{
          data?: Array<Record<string, unknown>>;
        }>(`${catalog_id}/product_sets`, {
          params: { fields: "id,name,filter,product_count", limit },
        });
        return ok({ data: res.data ?? [] });
      } catch (err) {
        return fail(err);
      }
    },
  );

  writeTool(
    server,
    "create_catalog",
    `⚠️ WRITE OPERATION — Create a new product catalog under a business.

Vertical defaults to 'commerce'; other options include 'hotels', 'flights', 'destinations', 'vehicles', 'home_listings', 'media_title'. Pick the right one — it's not changeable after creation.`,
    {
      business_id: z.string(),
      name: z.string().min(1),
      vertical: z
        .enum([
          "commerce",
          "hotels",
          "flights",
          "destinations",
          "vehicles",
          "home_listings",
          "media_title",
          "offline_commerce",
          "ticketed_experiences",
          "transactable_items",
        ])
        .default("commerce"),
      extra: z.record(z.string(), z.unknown()).optional(),
    },
    async (args) => {
      try {
        const body = {
          name: args.name,
          vertical: args.vertical,
          ...(args.extra ?? {}),
        };
        const res = await graphFetch<CatalogCreateResponse>(
          `${args.business_id}/owned_product_catalogs`,
          { method: "POST", body },
        );
        return ok({ id: res.id, vertical: args.vertical });
      } catch (err) {
        return fail(err);
      }
    },
  );

  writeTool(
    server,
    "create_product_set",
    `⚠️ WRITE OPERATION — Create a product set inside a catalog.

\`filter\` uses Meta's catalog filter syntax (e.g. { brand: { eq: 'Nike' } }, or { '\\$and': [...] }). Omit filter to target all products in the catalog.`,
    {
      catalog_id: z.string(),
      name: z.string().min(1),
      filter: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Catalog filter spec. Omit to include all products."),
      extra: z.record(z.string(), z.unknown()).optional(),
    },
    async (args) => {
      try {
        const body: Record<string, unknown> = {
          name: args.name,
          ...(args.filter && { filter: args.filter }),
          ...(args.extra ?? {}),
        };
        const res = await graphFetch<ProductSetCreateResponse>(
          `${args.catalog_id}/product_sets`,
          { method: "POST", body },
        );
        return ok({ id: res.id });
      } catch (err) {
        return fail(err);
      }
    },
  );

  writeTool(
    server,
    "bulk_upsert_products",
    `⚠️ WRITE OPERATION — Batch create / update / delete products in a catalog via /items_batch.

\`requests\` is an array of { method, data } where:
  - method: CREATE | UPDATE | DELETE
  - data: full product fields for CREATE; partial for UPDATE; { id, retailer_id } for DELETE

\`allow_upsert: true\` (v24+ feature) makes UPDATE behave as create-if-missing — common pattern for feed syncs.

Limits Meta enforces (also enforced locally before sending so failures surface as clear errors, not API rejects):
  - ${ITEMS_BATCH_HARD_CAP_ROWS} items per request
  - ${Math.round(ITEMS_BATCH_HARD_CAP_BYTES / 1024 / 1024)} MB per request body`,
    {
      catalog_id: z.string(),
      requests: z
        .array(
          z.object({
            method: ITEM_METHOD,
            data: z
              .record(z.string(), z.unknown())
              .describe(
                "Product fields. Required for all: retailer_id (your SKU). For CREATE/UPDATE also: name, description, availability, condition, price, link, image_url, brand, gtin / mpn etc.",
              ),
          }),
        )
        .min(1),
      allow_upsert: z
        .boolean()
        .default(false)
        .describe(
          "v24+ — when true, UPDATE methods create the product if it doesn't exist (upsert semantics).",
        ),
      item_type: z
        .enum([
          "PRODUCT_ITEM",
          "HOTEL",
          "FLIGHT",
          "DESTINATION",
          "VEHICLE",
          "HOME_LISTING",
        ])
        .default("PRODUCT_ITEM"),
    },
    async (args) => {
      try {
        const { body } = prepareItemsBatch({
          requests: args.requests,
          allow_upsert: args.allow_upsert,
          item_type: args.item_type,
        });
        const res = await graphFetch<ItemsBatchResponse>(
          `${args.catalog_id}/items_batch`,
          { method: "POST", body },
        );
        return ok({
          handles: res.handles,
          validation_status: res.validation_status,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  writeTool(
    server,
    "delete_product_set",
    "⚠️ WRITE OPERATION — Delete a product set. Products themselves are untouched (use bulk_upsert_products with method=DELETE for that).",
    { product_set_id: z.string() },
    async ({ product_set_id }) => {
      try {
        const res = await graphFetch<{ success?: boolean }>(product_set_id, {
          method: "DELETE",
        });
        return ok({ product_set_id, deleted: res.success ?? true });
      } catch (err) {
        return fail(err);
      }
    },
  );

  writeTool(
    server,
    "delete_catalog",
    "⚠️ WRITE OPERATION — Delete a product catalog. Irreversible. Removes ALL products, product sets, and references in DPA creatives.",
    { catalog_id: z.string() },
    async ({ catalog_id }) => {
      try {
        const res = await graphFetch<{ success?: boolean }>(catalog_id, {
          method: "DELETE",
        });
        return ok({ catalog_id, deleted: res.success ?? true });
      } catch (err) {
        return fail(err);
      }
    },
  );

  writeTool(
    server,
    "create_dpa_creative",
    `⚠️ WRITE OPERATION — Create a Dynamic Product Ad (DPA) creative referencing a catalog + product set.

The creative is the "template" — Meta dynamically inserts product data (image, name, price, etc.) from the product set at render time. Required fields:
  - account_id, page_id (the page owning the ad)
  - product_set_id (the catalog product set to dynamically render from)
  - template_url (where users land — supports {{product.id}} / {{product.retailer_id}} substitution)
  - message + name (copy) — Meta will fill in product-specific copy via {{product.name}}, etc.

For Advantage+ Catalog Ads (the new format that supersedes traditional DPA), the underlying creative create call is the same; the difference is set at the campaign/adset level (objective=OUTCOME_SALES + special creative rules).`,
    {
      account_id: z.string(),
      name: z.string().min(1).describe("Internal creative name."),
      page_id: z.string(),
      product_set_id: z.string(),
      template_url: z
        .string()
        .url()
        .describe(
          "Landing URL. Use Meta's template tokens for per-product values: {{product.id}}, {{product.retailer_id}}, {{product.url}}.",
        ),
      message: z
        .string()
        .describe(
          "Primary text. Supports template tokens: {{product.name}}, {{product.price}}, {{product.brand}}.",
        ),
      headline_name: z
        .string()
        .optional()
        .describe("Headline. Defaults to {{product.name}} if omitted."),
      description: z
        .string()
        .optional()
        .describe("Link description. Supports template tokens."),
      call_to_action_type: z
        .enum([
          "LEARN_MORE",
          "SHOP_NOW",
          "BUY_NOW",
          "GET_OFFER",
          "GET_QUOTE",
          "BOOK_TRAVEL",
          "SIGN_UP",
          "SUBSCRIBE",
          "GET_DIRECTIONS",
          "MESSAGE_PAGE",
        ])
        .default("SHOP_NOW"),
      extra: z.record(z.string(), z.unknown()).optional(),
    },
    async (args) => {
      try {
        const actId = normalizeActId(args.account_id);
        const body = {
          name: args.name,
          object_story_spec: {
            page_id: args.page_id,
            template_data: {
              link: args.template_url,
              message: args.message,
              name: args.headline_name ?? "{{product.name}}",
              ...(args.description && { description: args.description }),
              call_to_action: {
                type: args.call_to_action_type,
                value: { link: args.template_url },
              },
            },
          },
          product_set_id: args.product_set_id,
          ...(args.extra ?? {}),
        };
        const res = await graphFetch<{ id: string }>(`${actId}/adcreatives`, {
          method: "POST",
          body,
        });
        return ok({ id: res.id, product_set_id: args.product_set_id });
      } catch (err) {
        return fail(err);
      }
    },
  );
}

/**
 * Pure helper — validates and shapes the items_batch payload. Exported for tests.
 * Throws if the batch exceeds Meta's caps (row count or body size).
 */
export function prepareItemsBatch(input: {
  requests: Array<{ method: string; data: Record<string, unknown> }>;
  allow_upsert?: boolean;
  item_type?: string;
}): { body: Record<string, unknown>; bodySize: number } {
  if (input.requests.length === 0) {
    throw new Error("requests cannot be empty");
  }
  if (input.requests.length > ITEMS_BATCH_HARD_CAP_ROWS) {
    throw new Error(
      `${input.requests.length} requests exceeds the ${ITEMS_BATCH_HARD_CAP_ROWS}-per-batch cap`,
    );
  }
  const body = {
    requests: input.requests,
    allow_upsert: input.allow_upsert ?? false,
    item_type: input.item_type ?? "PRODUCT_ITEM",
  };
  // Meta's cap is in UTF-8 bytes — measure with Buffer.byteLength so multibyte
  // characters (emoji, non-Latin scripts) count correctly. String.length would
  // undercount and let a too-large request through to be rejected by Meta.
  const bodySize = Buffer.byteLength(JSON.stringify(body), "utf8");
  if (bodySize > ITEMS_BATCH_HARD_CAP_BYTES) {
    throw new Error(
      `Body is ${Math.round(bodySize / 1024 / 1024)} MB, exceeds the 30 MB cap`,
    );
  }
  return { body, bodySize };
}
