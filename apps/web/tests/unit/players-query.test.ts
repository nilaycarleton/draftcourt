import { describe, expect, it } from "vitest";
import { playersQuerySchema, toPlayerListQuery } from "@/lib/server/players-query";

describe("playersQuerySchema", () => {
  it("treats blank numeric filter fields as absent, not zero", () => {
    // Regression test: PlayerFilterForm's "More filters" panel submits
    // every numeric input even when left blank (a closed <details> still
    // submits its fields) — `z.coerce.number()` on an empty string
    // previously coerced to 0 and got treated as an active "exactly 0"
    // filter, zeroing out every real result. Found via a live E2E run
    // against the real filter form, not by unit-testing in isolation.
    const parsed = playersQuerySchema.parse({
      name: "Cunningham",
      ageMin: "",
      ageMax: "",
      rankMin: "",
      rankMax: "",
      injuryRiskMax: "",
    });
    expect(parsed.ageMin).toBeUndefined();
    expect(parsed.ageMax).toBeUndefined();
    expect(parsed.rankMin).toBeUndefined();
    expect(parsed.rankMax).toBeUndefined();
    expect(parsed.injuryRiskMax).toBeUndefined();

    const query = toPlayerListQuery(parsed);
    expect(query.filters.ageMin).toBeUndefined();
    expect(query.filters.ageMax).toBeUndefined();
    expect(query.filters.ranges).toEqual({});
  });

  it("still coerces a real numeric value correctly", () => {
    const parsed = playersQuerySchema.parse({ ageMin: "25", rankMax: "50" });
    expect(parsed.ageMin).toBe(25);
    expect(parsed.rankMax).toBe(50);

    const query = toPlayerListQuery(parsed);
    expect(query.filters.ageMin).toBe(25);
    expect(query.filters.ranges?.overallRank).toEqual({ max: 50 });
  });

  it("treats an explicit 0 as a real filter value, not absent", () => {
    const parsed = playersQuerySchema.parse({ rankMin: "0" });
    expect(parsed.rankMin).toBe(0);
    const query = toPlayerListQuery(parsed);
    expect(query.filters.ranges?.overallRank).toEqual({ min: 0 });
  });

  it("empty position/availability selects don't apply an empty-array filter", () => {
    const parsed = playersQuerySchema.parse({ position: "", availability: "" });
    const query = toPlayerListQuery(parsed);
    // compact() only strips `undefined`, so an empty array from csv()
    // parsing "" does pass through — callers must guard on `.length`
    // (players.ts::buildPlayerWhere already does). This test pins that
    // contract so a future refactor can't silently drop the guard.
    expect(query.filters.position).toEqual([]);
    expect(query.filters.availability).toEqual([]);
  });

  it("accepts the live draft room's full-pool fetch (limit=600)", () => {
    // Regression test: the room requests limit=600 for search-to-draft, but
    // the schema capped limit at 100 → 422 → an empty in-room pool. Found
    // via the authenticated E2E acceptance draft.
    const parsed = playersQuerySchema.parse({ limit: "600" });
    expect(parsed.limit).toBe(600);
    expect(() => playersQuerySchema.parse({ limit: "1001" })).toThrow();
  });
});
