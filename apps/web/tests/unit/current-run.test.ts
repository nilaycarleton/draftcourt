import { describe, expect, it } from "vitest";
import { ageAt, ageRangeToDobRange, PROJECTION_AS_OF } from "@/lib/server/current-run";

describe("ageAt", () => {
  it("returns null for a null dob", () => {
    expect(ageAt(null)).toBeNull();
  });

  it("computes fractional age relative to PROJECTION_AS_OF", () => {
    const dob = new Date("2000-10-01T00:00:00.000Z");
    expect(ageAt(dob)).toBeCloseTo(26.0, 1);
  });

  it("computes age relative to a custom as-of date", () => {
    const dob = new Date("2000-01-01T00:00:00.000Z");
    const asOf = new Date("2010-01-01T00:00:00.000Z");
    expect(ageAt(dob, asOf)).toBeCloseTo(10.0, 1);
  });
});

describe("ageRangeToDobRange", () => {
  it("returns an empty range when neither bound is given", () => {
    expect(ageRangeToDobRange(undefined, undefined)).toEqual({});
  });

  it("maxAge produces a gte dob bound (younger players born more recently)", () => {
    const range = ageRangeToDobRange(undefined, 25);
    expect(range.gte).toBeInstanceOf(Date);
    expect(range.lte).toBeUndefined();
  });

  it("minAge produces an lte dob bound", () => {
    const range = ageRangeToDobRange(20, undefined);
    expect(range.lte).toBeInstanceOf(Date);
    expect(range.gte).toBeUndefined();
  });

  it("a player born exactly minAge years before PROJECTION_AS_OF falls within the range", () => {
    const minAge = 22;
    const dob = new Date(PROJECTION_AS_OF);
    dob.setUTCFullYear(dob.getUTCFullYear() - minAge);
    const range = ageRangeToDobRange(minAge, undefined);
    expect(dob.getTime()).toBeLessThanOrEqual(range.lte?.getTime() ?? Number.NEGATIVE_INFINITY);
  });

  it("both bounds together produce a valid gte <= lte range", () => {
    const range = ageRangeToDobRange(20, 30);
    expect(range.gte?.getTime() ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      range.lte?.getTime() ?? Number.NEGATIVE_INFINITY,
    );
  });
});
