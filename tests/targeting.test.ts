import { describe, expect, test } from "bun:test";
import { assembleTargeting } from "@/tools/targeting";

describe("assembleTargeting (build_targeting pure-spec assembly)", () => {
  test("countries-only produces minimal valid spec", () => {
    const spec = assembleTargeting({ countries: ["US", "CA"] });
    expect(spec).toEqual({ geo_locations: { countries: ["US", "CA"] } });
  });

  test("age range surfaces as age_min / age_max", () => {
    const spec = assembleTargeting({
      countries: ["US"],
      age_min: 25,
      age_max: 54,
    });
    expect(spec).toEqual({
      geo_locations: { countries: ["US"] },
      age_min: 25,
      age_max: 54,
    });
  });

  test("genders map male=1 / female=2; 'all' is dropped", () => {
    const male = assembleTargeting({ genders: ["male"] });
    expect(male.genders).toEqual([1]);

    const female = assembleTargeting({ genders: ["female"] });
    expect(female.genders).toEqual([2]);

    const both = assembleTargeting({ genders: ["male", "female"] });
    expect(both.genders).toEqual([1, 2]);

    const all = assembleTargeting({ genders: ["all"] });
    // 'all' alone produces no genders key (= no restriction).
    expect(all.genders).toBeUndefined();
  });

  test("interests become flexible_spec[0].interests as {id,name} objects", () => {
    const spec = assembleTargeting({
      countries: ["US"],
      interests: [
        { id: "6003107902433", name: "Fitness and wellness" },
        { id: "6003020834693", name: "Health" },
      ],
    });
    expect(spec.flexible_spec).toEqual([
      {
        interests: [
          { id: "6003107902433", name: "Fitness and wellness" },
          { id: "6003020834693", name: "Health" },
        ],
      },
    ]);
  });

  test("interests + behaviors share the same flexible_spec entry (AND'd together)", () => {
    const spec = assembleTargeting({
      interests: [{ id: "I1", name: "Fitness" }],
      behaviors: [{ id: "B1", name: "Frequent travelers" }],
    });
    expect(spec.flexible_spec).toEqual([
      {
        interests: [{ id: "I1", name: "Fitness" }],
        behaviors: [{ id: "B1", name: "Frequent travelers" }],
      },
    ]);
  });

  test("custom audiences include + exclude wrap IDs in {id} objects", () => {
    const spec = assembleTargeting({
      custom_audiences: ["A1", "A2"],
      exclude_custom_audiences: ["E1"],
    });
    expect(spec.custom_audiences).toEqual([{ id: "A1" }, { id: "A2" }]);
    expect(spec.excluded_custom_audiences).toEqual([{ id: "E1" }]);
  });

  test("publisher + device platforms pass through verbatim", () => {
    const spec = assembleTargeting({
      device_platforms: ["mobile"],
      publisher_platforms: ["facebook", "instagram"],
    });
    expect(spec.device_platforms).toEqual(["mobile"]);
    expect(spec.publisher_platforms).toEqual(["facebook", "instagram"]);
  });

  test("regions and cities wrap keys in {key} objects", () => {
    const spec = assembleTargeting({
      regions: ["3886"],
      cities: ["2421042"],
    });
    expect(spec.geo_locations).toEqual({
      regions: [{ key: "3886" }],
      cities: [{ key: "2421042" }],
    });
  });

  test("empty input produces empty spec (no spurious geo_locations)", () => {
    expect(assembleTargeting({})).toEqual({});
  });
});
