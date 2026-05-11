import { describe, expect, test } from "bun:test";
import { prepareItemsBatch } from "@/tools/catalogs";

describe("prepareItemsBatch — local validation before sending to /items_batch", () => {
  test("packs minimal CREATE request into the wire shape", () => {
    const { body, bodySize } = prepareItemsBatch({
      requests: [
        {
          method: "CREATE",
          data: {
            retailer_id: "SKU-1",
            name: "Test Product",
            availability: "in stock",
            condition: "new",
            price: "9.99 USD",
            link: "https://example.com/p/1",
            image_url: "https://example.com/p/1.jpg",
          },
        },
      ],
    });
    expect(body.allow_upsert).toBe(false);
    expect(body.item_type).toBe("PRODUCT_ITEM");
    expect((body.requests as unknown[]).length).toBe(1);
    expect(bodySize).toBeGreaterThan(0);
  });

  test("preserves allow_upsert when caller sets it", () => {
    const { body } = prepareItemsBatch({
      requests: [{ method: "UPDATE", data: { retailer_id: "SKU-2", price: "5.00 USD" } }],
      allow_upsert: true,
    });
    expect(body.allow_upsert).toBe(true);
  });

  test("preserves item_type override", () => {
    const { body } = prepareItemsBatch({
      requests: [{ method: "CREATE", data: { retailer_id: "ROOM-1" } }],
      item_type: "HOTEL",
    });
    expect(body.item_type).toBe("HOTEL");
  });

  test("measures body size as UTF-8 bytes, not JS string length", () => {
    const { body, bodySize } = prepareItemsBatch({
      requests: [{ method: "CREATE", data: { retailer_id: "SKU-emoji", name: "😀" } }],
    });
    expect(bodySize).toBe(Buffer.byteLength(JSON.stringify(body), "utf8"));
    expect(bodySize).toBeGreaterThan(JSON.stringify(body).length);
  });

  test("throws on empty requests", () => {
    expect(() => prepareItemsBatch({ requests: [] })).toThrow(/cannot be empty/);
  });

  test("throws above the 5000-row Meta cap", () => {
    const requests = Array.from({ length: 5_001 }, (_, i) => ({
      method: "CREATE",
      data: { retailer_id: `SKU-${i}` },
    }));
    expect(() => prepareItemsBatch({ requests })).toThrow(
      /exceeds the 5000-per-batch cap/,
    );
  });

  test("accepts exactly 5000 rows (at the cap)", () => {
    const requests = Array.from({ length: 5_000 }, (_, i) => ({
      method: "CREATE",
      data: { retailer_id: `SKU-${i}` },
    }));
    const { body } = prepareItemsBatch({ requests });
    expect((body.requests as unknown[]).length).toBe(5_000);
  });

  test("throws above the 30 MB body cap", () => {
    // Build a single huge request that pushes the body past 30 MB.
    const bigDescription = "x".repeat(31 * 1024 * 1024);
    const requests = [
      {
        method: "CREATE",
        data: { retailer_id: "SKU-big", description: bigDescription },
      },
    ];
    expect(() => prepareItemsBatch({ requests })).toThrow(/30 MB cap/);
  });

  test("byte counting catches multibyte payloads JS chars would miss", () => {
    // "🛒" is 4 bytes in UTF-8 but 2 UTF-16 code units (JS `.length` = 2).
    // Build a payload that's just under 30M chars but over 30M bytes — the
    // old `.length` check would have let it through; byteLength correctly
    // rejects it.
    const fourByteChar = "🛒"; // 4 bytes UTF-8, 2 UTF-16 units
    // 16 MB of emoji = 32 MB UTF-8 bytes but 32M UTF-16 units (which is also
    // over the cap by `.length`, so we need something more subtle). Construct
    // a string ~16M chars made of 4-byte emoji → 64 MB UTF-8 bytes, 16M+
    // UTF-16 units. `.length` < 30M chars but byteLength > 30M bytes.
    // Then wrap in JSON structure with the requested retailer_id etc.
    // We use 8M emoji (16M UTF-16 units, 32M UTF-8 bytes).
    const heavyDescription = fourByteChar.repeat(8 * 1024 * 1024);
    const requests = [
      {
        method: "CREATE",
        data: { retailer_id: "SKU-emoji", description: heavyDescription },
      },
    ];
    // Sanity check on the test setup: chars < 30M, bytes > 30M.
    const json = JSON.stringify({
      requests,
      allow_upsert: false,
      item_type: "PRODUCT_ITEM",
    });
    expect(json.length).toBeLessThan(30 * 1024 * 1024);
    expect(Buffer.byteLength(json, "utf8")).toBeGreaterThan(30 * 1024 * 1024);
    // The check should fire on bytes.
    expect(() => prepareItemsBatch({ requests })).toThrow(/30 MB cap/);
  });

  test("DELETE method only needs retailer_id", () => {
    const { body } = prepareItemsBatch({
      requests: [{ method: "DELETE", data: { retailer_id: "SKU-DEAD" } }],
    });
    expect(((body.requests as unknown[])[0] as Record<string, unknown>).method).toBe(
      "DELETE",
    );
  });
});
