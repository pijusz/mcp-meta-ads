import { describe, expect, test } from "bun:test";
import { hashField } from "@/services/pii";
import { hashCapiUserData, prepareEvent } from "@/tools/capi";

describe("hashCapiUserData — CAPI field hashing", () => {
  test("hashes em (email) using EMAIL normalization rules", () => {
    const out = hashCapiUserData({ em: "  John.Doe@Example.COM  " });
    // SHA256("john.doe@example.com")
    const expected = hashField("EMAIL", "john.doe@example.com");
    expect(out.em).toEqual([expected]);
  });

  test("hashes ph (phone) using PHONE normalization (digits only, no leading zeros)", () => {
    const out = hashCapiUserData({ ph: "+1 (415) 555-1234" });
    const expected = hashField("PHONE", "+1 (415) 555-1234");
    expect(out.ph).toEqual([expected]);
  });

  test("array values hash element-wise", () => {
    const out = hashCapiUserData({ em: ["a@b.com", "c@d.com"] });
    const expected = [hashField("EMAIL", "a@b.com"), hashField("EMAIL", "c@d.com")];
    expect(out.em).toEqual(expected);
  });

  test("raw fields pass through unchanged (client_ip_address, fbc, fbp, client_user_agent)", () => {
    const out = hashCapiUserData({
      client_ip_address: "203.0.113.4",
      client_user_agent: "Mozilla/5.0",
      fbc: "fb.1.1715000000000.IwAR123",
      fbp: "fb.1.1715000000000.456",
    });
    expect(out.client_ip_address).toBe("203.0.113.4");
    expect(out.client_user_agent).toBe("Mozilla/5.0");
    expect(out.fbc).toBe("fb.1.1715000000000.IwAR123");
    expect(out.fbp).toBe("fb.1.1715000000000.456");
  });

  test("country drives ZIP normalization (US truncates to 5; GB preserves)", () => {
    const us = hashCapiUserData({ zp: "94110-1234", country: "US" });
    const expectedUs = hashField("ZIP", "94110-1234", { country: "us" });
    expect(us.zp).toEqual([expectedUs]);

    const gb = hashCapiUserData({ zp: "SW1A 1AA", country: "GB" });
    const expectedGb = hashField("ZIP", "SW1A 1AA", { country: "gb" });
    expect(gb.zp).toEqual([expectedGb]);

    // country still gets hashed too
    expect(us.country).toBeDefined();
  });

  test("blank fields are dropped (never SHA256 empty string)", () => {
    const out = hashCapiUserData({
      em: "",
      ph: "   ",
      fn: "good",
      client_ip_address: "",
    });
    expect(out).not.toHaveProperty("em");
    expect(out).not.toHaveProperty("ph");
    expect(out).not.toHaveProperty("client_ip_address");
    expect(out.fn).toEqual([hashField("FN", "good")]);
  });

  test("unknown CAPI fields fail closed instead of passing possible PII raw", () => {
    expect(() => hashCapiUserData({ some_future_field: "value-as-is" })).toThrow(
      /Unsupported CAPI user_data field "some_future_field"/,
    );
  });

  test("rejects non-string hashable values instead of silently dropping them", () => {
    expect(() => hashCapiUserData({ em: 123 })).toThrow(
      /Invalid CAPI user_data field "em"/,
    );
    expect(() => hashCapiUserData({ ph: ["+14155551234", 123] })).toThrow(
      /Invalid CAPI user_data field "ph"/,
    );
  });

  test("hashes ge (gender) to single char before SHA256", () => {
    const out = hashCapiUserData({ ge: "Female" });
    // hashField('GEN', 'Female') normalizes to 'f' then SHA256s
    expect(out.ge).toEqual([hashField("GEN", "Female")]);
  });

  test("hashes CAPI-specific name and DOB fragments instead of passing them raw", () => {
    const out = hashCapiUserData({
      f5first: "Éleanor",
      f5last: " O'Connor ",
      fi: "Éleanor",
      doby: "1985",
      dobm: "7",
      dobd: "03",
    });
    expect(out.f5first).toEqual([hashField("F5FIRST", "Éleanor")]);
    expect(out.f5last).toEqual([hashField("F5LAST", " O'Connor ")]);
    expect(out.fi).toEqual([hashField("FI", "Éleanor")]);
    expect(out.doby).toEqual([hashField("DOBY", "1985")]);
    expect(out.dobm).toEqual([hashField("DOBM", "7")]);
    expect(out.dobd).toEqual([hashField("DOBD", "03")]);
  });
});

describe("prepareEvent — full event shaping", () => {
  test("defaults event_time to now when omitted", () => {
    const before = Math.floor(Date.now() / 1000);
    const ev = prepareEvent({
      event_name: "Purchase",
      action_source: "email",
      user_data: { em: "a@b.com" },
    });
    const after = Math.floor(Date.now() / 1000);
    expect(typeof ev.event_time).toBe("number");
    expect(ev.event_time as number).toBeGreaterThanOrEqual(before);
    expect(ev.event_time as number).toBeLessThanOrEqual(after);
  });

  test("preserves explicit event_time", () => {
    const ev = prepareEvent({
      event_name: "Lead",
      event_time: 1730000000,
      action_source: "email",
      user_data: { em: "a@b.com" },
    });
    expect(ev.event_time).toBe(1730000000);
  });

  test("includes event_id only when provided (browser/CAPI dedup)", () => {
    const without = prepareEvent({
      event_name: "Purchase",
      action_source: "email",
      user_data: { em: "a@b.com" },
    });
    expect(without).not.toHaveProperty("event_id");

    const withId = prepareEvent({
      event_name: "Purchase",
      action_source: "email",
      event_id: "order_12345",
      user_data: { em: "a@b.com" },
    });
    expect(withId.event_id).toBe("order_12345");
  });

  test("passes custom_data through verbatim (currency, value, contents, etc.)", () => {
    const ev = prepareEvent({
      event_name: "Purchase",
      action_source: "email",
      user_data: { em: "a@b.com" },
      custom_data: {
        currency: "USD",
        value: 49.99,
        content_ids: ["SKU-1", "SKU-2"],
        order_id: "ORD-100",
      },
    });
    expect(ev.custom_data).toEqual({
      currency: "USD",
      value: 49.99,
      content_ids: ["SKU-1", "SKU-2"],
      order_id: "ORD-100",
    });
  });

  test("hashes user_data inside the prepared event", () => {
    const ev = prepareEvent({
      event_name: "Purchase",
      action_source: "email",
      user_data: { em: "a@b.com", client_ip_address: "203.0.113.4" },
    });
    const ud = ev.user_data as Record<string, unknown>;
    expect(ud.em).toEqual([hashField("EMAIL", "a@b.com")]);
    expect(ud.client_ip_address).toBe("203.0.113.4");
  });

  test("requires event_source_url and client_user_agent for website events", () => {
    expect(() =>
      prepareEvent({
        event_name: "PageView",
        action_source: "website",
        user_data: { client_user_agent: "Mozilla/5.0" },
      }),
    ).toThrow(/event_source_url is required/);

    expect(() =>
      prepareEvent({
        event_name: "PageView",
        action_source: "website",
        event_source_url: "https://example.invalid/",
        user_data: {},
      }),
    ).toThrow(/user_data\.client_user_agent is required/);

    const ev = prepareEvent({
      event_name: "PageView",
      action_source: "website",
      event_source_url: "https://example.invalid/",
      user_data: { client_user_agent: "Mozilla/5.0" },
    });
    expect(ev.event_source_url).toBe("https://example.invalid/");
  });
});
