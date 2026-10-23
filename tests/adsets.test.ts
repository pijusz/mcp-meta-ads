import { describe, expect, test } from "bun:test";
import { withAdvantageAudience } from "@/tools/adsets";

describe("withAdvantageAudience", () => {
  test("returns targeting unchanged when flag is undefined", () => {
    const t = { geo_locations: { countries: ["US"] } };
    expect(withAdvantageAudience(t, undefined)).toBe(t);
  });

  test("adds targeting_automation.advantage_audience", () => {
    const t = { geo_locations: { countries: ["US"] } };
    expect(withAdvantageAudience(t, 0)).toEqual({
      geo_locations: { countries: ["US"] },
      targeting_automation: { advantage_audience: 0 },
    });
  });

  test("keeps other targeting_automation keys and overrides the flag", () => {
    const t = {
      targeting_automation: { advantage_audience: 1, individual_setting: { age: 1 } },
    };
    expect(withAdvantageAudience(t, 0)).toEqual({
      targeting_automation: { advantage_audience: 0, individual_setting: { age: 1 } },
    });
  });
});
