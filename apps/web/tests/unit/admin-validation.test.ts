import { describe, expect, it } from "vitest";
import { createOverrideSchema, createSignalSchema } from "@/lib/server/admin-validation";

const PLAYER_ID = "00000000-0000-4000-8000-000000000001";

const baseOverride = {
  playerId: PLAYER_ID,
  season: "2026-27",
  stat: "pts",
  rationale: "Confirmed starter change per beat reporter.",
  effectiveAt: "2026-08-21T00:00:00.000Z",
};

describe("createOverrideSchema", () => {
  it("accepts a valid deltaValue-only override", () => {
    const result = createOverrideSchema.safeParse({ ...baseOverride, deltaValue: 2.5 });
    expect(result.success).toBe(true);
  });

  it("accepts a valid replacementValue-only override", () => {
    const result = createOverrideSchema.safeParse({ ...baseOverride, replacementValue: 30 });
    expect(result.success).toBe(true);
  });

  it("rejects neither deltaValue nor replacementValue set", () => {
    const result = createOverrideSchema.safeParse(baseOverride);
    expect(result.success).toBe(false);
  });

  it("rejects both deltaValue and replacementValue set", () => {
    const result = createOverrideSchema.safeParse({
      ...baseOverride,
      deltaValue: 1,
      replacementValue: 30,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a blank/whitespace-only rationale", () => {
    const result = createOverrideSchema.safeParse({
      ...baseOverride,
      deltaValue: 1,
      rationale: "   ",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown stat key", () => {
    const result = createOverrideSchema.safeParse({
      ...baseOverride,
      deltaValue: 1,
      stat: "fantasyPoints",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative replacementValue", () => {
    const result = createOverrideSchema.safeParse({ ...baseOverride, replacementValue: -5 });
    expect(result.success).toBe(false);
  });
});

const baseSignal = {
  playerId: PLAYER_ID,
  type: "ROLE_UP",
  impact: 0.5,
  confidence: 0.8,
  effectiveAt: "2026-08-21T00:00:00.000Z",
};

describe("createSignalSchema", () => {
  it("accepts a valid signal", () => {
    expect(createSignalSchema.safeParse(baseSignal).success).toBe(true);
  });

  it("rejects impact outside [0,1]", () => {
    expect(createSignalSchema.safeParse({ ...baseSignal, impact: 1.5 }).success).toBe(false);
    expect(createSignalSchema.safeParse({ ...baseSignal, impact: -0.1 }).success).toBe(false);
  });

  it("rejects confidence outside [0,1]", () => {
    expect(createSignalSchema.safeParse({ ...baseSignal, confidence: 2 }).success).toBe(false);
  });

  it("rejects an unknown signal type", () => {
    expect(createSignalSchema.safeParse({ ...baseSignal, type: "BREAKOUT" }).success).toBe(false);
  });

  it("allows rationale to be omitted", () => {
    expect(createSignalSchema.safeParse(baseSignal).success).toBe(true);
  });
});
