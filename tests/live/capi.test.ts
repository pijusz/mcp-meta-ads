import { describe, expect, test } from "bun:test";
import { graphFetch } from "@/services/meta-graph-api";
import { prepareEvent } from "@/tools/capi";
import {
  getTestAccountId,
  getTestEventCode,
  getTestPixelId,
  liveCapiSkipReason,
  liveCapiTestsEnabled,
} from "./_helpers";

/**
 * Live CAPI tests POST events to META_ADS_TEST_PIXEL_ID. Use a dedicated test
 * pixel, provide the Events Manager → Test Events code via META_ADS_TEST_EVENT_CODE,
 * and set META_ADS_ALLOW_CAPI_EVENT_WRITES=true to acknowledge the permanent write.
 */

describe.skipIf(!liveCapiTestsEnabled())(`[live] CAPI (${liveCapiSkipReason()})`, () => {
  test("list_pixels returns at least the configured test pixel", async () => {
    const actId = getTestAccountId();
    const pixelId = getTestPixelId();
    const res = await graphFetch<{
      data?: Array<{ id: string; name?: string }>;
    }>(`${actId}/adspixels`, {
      params: { fields: "id,name", limit: 100 },
    });
    const data = res.data ?? [];
    const found = data.find((p) => p.id === pixelId);
    expect(found).toBeDefined();
  });

  test("send_conversion_events with test_event_code accepts a Purchase event", async () => {
    const pixelId = getTestPixelId();
    const event = prepareEvent({
      event_name: "Purchase",
      action_source: "website",
      event_source_url: "https://example.invalid/checkout/complete",
      event_id: `mcp-test-${Date.now()}`,
      user_data: {
        em: "mcp-test-user@example.invalid",
        client_ip_address: "203.0.113.4",
        client_user_agent: "Mozilla/5.0 (mcp-meta-ads-test)",
      },
      custom_data: {
        currency: "USD",
        value: 9.99,
        order_id: `mcp-test-order-${Date.now()}`,
      },
    });
    const res = await graphFetch<{
      events_received?: number;
      fbtrace_id?: string;
    }>(`${pixelId}/events`, {
      method: "POST",
      body: {
        data: [event],
        partner_agent: "mcp-meta-ads",
        test_event_code: getTestEventCode(),
      },
    });
    expect(res.events_received).toBeGreaterThanOrEqual(1);
  }, 30_000);

  test("send_conversion_events batches multiple events in one request", async () => {
    const pixelId = getTestPixelId();
    const events = ["ViewContent", "AddToCart", "InitiateCheckout"].map((name, i) =>
      prepareEvent({
        event_name: name,
        action_source: "website",
        event_source_url: `https://example.invalid/page-${i}`,
        event_id: `mcp-test-${name}-${Date.now()}`,
        user_data: {
          em: `mcp-test-${i}@example.invalid`,
          client_ip_address: "203.0.113.4",
          client_user_agent: "Mozilla/5.0",
        },
      }),
    );
    const res = await graphFetch<{ events_received?: number }>(`${pixelId}/events`, {
      method: "POST",
      body: {
        data: events,
        partner_agent: "mcp-meta-ads",
        test_event_code: getTestEventCode(),
      },
    });
    expect(res.events_received).toBeGreaterThanOrEqual(events.length);
  }, 30_000);
});
