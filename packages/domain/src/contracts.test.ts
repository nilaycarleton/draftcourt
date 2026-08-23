import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  leagueScoringRuleSchema,
  projectedLineSchema,
  recommendationSchema,
  scoreComponentSchema,
} from "./contracts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, "../../../data/schemas/fixtures");

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(fixturesDir, `${name}.json`), "utf-8"));
}

describe("shared contract fixtures", () => {
  it("validates the league scoring rule fixture", () => {
    const result = leagueScoringRuleSchema.safeParse(loadFixture("league-scoring-rule"));
    expect(result.success).toBe(true);
  });

  it("validates the projected line fixture", () => {
    const result = projectedLineSchema.safeParse(loadFixture("projected-line"));
    expect(result.success).toBe(true);
  });

  it("validates the score component fixture", () => {
    const result = scoreComponentSchema.safeParse(loadFixture("score-component"));
    expect(result.success).toBe(true);
  });

  it("validates the recommendation fixture", () => {
    const result = recommendationSchema.safeParse(loadFixture("recommendation"));
    expect(result.success).toBe(true);
  });

  it("rejects a recommendation with an out-of-range draftScore", () => {
    const fixture = loadFixture("recommendation") as Record<string, unknown>;
    const result = recommendationSchema.safeParse({ ...fixture, draftScore: 142 });
    expect(result.success).toBe(false);
  });

  it("rejects a score component with an unknown key", () => {
    const fixture = loadFixture("score-component") as Record<string, unknown>;
    const result = scoreComponentSchema.safeParse({ ...fixture, key: "not-a-real-key" });
    expect(result.success).toBe(false);
  });
});
