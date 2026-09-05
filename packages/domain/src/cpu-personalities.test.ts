import { describe, expect, it } from "vitest";
import {
  CPU_MAX_TEMPERATURE,
  CPU_MIN_TEMPERATURE,
  CPU_PERSONALITY_VERSION,
  CPU_SEED_STRATEGY_VERSION,
  checksumCpuPersonalitySnapshot,
  cpuPersonalityByKey,
  cpuPersonalities,
  cpuFeatureDimensions,
  defaultCpuPersonalityKey,
  parseCpuPersonalitySnapshot,
  toCpuPersonalitySnapshot,
} from "./cpu-personalities";

/**
 * Contract tests for CPU personality seed data (Phase 3C): exactly eight
 * stable definitions, bounded temperatures, weights in [0,1] summing to 1,
 * fail-closed snapshot parsing, and content-addressed checksums.
 */

const WEIGHT_SUM_TOLERANCE = 5 * 10 ** -6 + 1e-9;

function snapshotOf(key: string) {
  const definition = cpuPersonalityByKey(key);
  if (!definition) throw new Error(`missing personality ${key}`);
  return toCpuPersonalitySnapshot(definition);
}

describe("cpu personalities", () => {
  it("defines exactly eight personalities with unique stable keys", () => {
    expect(cpuPersonalities).toHaveLength(8);
    const keys = cpuPersonalities.map((definition) => definition.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain(defaultCpuPersonalityKey);
    expect(cpuPersonalityByKey(defaultCpuPersonalityKey)?.key).toBe("balanced");
    expect(cpuPersonalityByKey("does-not-exist")).toBeUndefined();
  });

  it("pins version, seed strategy, and supported modes on every definition", () => {
    for (const definition of cpuPersonalities) {
      expect(definition.version).toBe(CPU_PERSONALITY_VERSION);
      expect(definition.version).toBe(1);
      expect(definition.seedStrategyVersion).toBe(CPU_SEED_STRATEGY_VERSION);
      expect(definition.seedStrategyVersion).toBe(1);
      expect([...definition.supportedModes]).toEqual(["MOCK", "DEMO"]);
      expect(definition.horizonNotes.length).toBeGreaterThan(0);
    }
  });

  it("keeps every temperature within the configured bounds", () => {
    for (const definition of cpuPersonalities) {
      expect(definition.temperature).toBeGreaterThanOrEqual(CPU_MIN_TEMPERATURE);
      expect(definition.temperature).toBeLessThanOrEqual(CPU_MAX_TEMPERATURE);
    }
  });

  it("has weights in [0,1] that total exactly 1.000000 at stored precision", () => {
    for (const definition of cpuPersonalities) {
      const dimensions = Object.keys(definition.weights).sort();
      expect(dimensions).toEqual([...cpuFeatureDimensions].sort());
      let total = 0;
      for (const dimension of cpuFeatureDimensions) {
        const value = definition.weights[dimension];
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
        total += value;
      }
      expect(Math.abs(total - 1)).toBeLessThanOrEqual(WEIGHT_SUM_TOLERANCE);
      // Exact at 6dp — the seed vectors were authored to sum to 1.000000.
      expect(Math.round(total * 10 ** 6)).toBe(10 ** 6);
    }
  });

  it("round-trips definitions through the snapshot parser", () => {
    for (const definition of cpuPersonalities) {
      const snapshot = toCpuPersonalitySnapshot(definition);
      expect(snapshot.snapshotVersion).toBe(1);
      expect(snapshot.displayLabel).toBe(definition.displayName);
      const roundTripped = parseCpuPersonalitySnapshot(
        JSON.parse(JSON.stringify(snapshot)) as unknown,
      );
      expect(roundTripped).toEqual(snapshot);
    }
  });

  it("fails closed on unknown snapshot versions", () => {
    const valid = snapshotOf("balanced");
    expect(() => parseCpuPersonalitySnapshot({ ...valid, snapshotVersion: 99 })).toThrow();
  });

  it("fails closed on out-of-bounds temperatures", () => {
    const valid = snapshotOf("balanced");
    expect(() => parseCpuPersonalitySnapshot({ ...valid, temperature: 0.39 })).toThrow();
    expect(() => parseCpuPersonalitySnapshot({ ...valid, temperature: 1.61 })).toThrow();
    expect(() => parseCpuPersonalitySnapshot({ ...valid, temperature: Number.NaN })).toThrow();
  });

  it("fails closed on weight bound and sum violations", () => {
    const valid = snapshotOf("balanced");

    const outOfBounds = {
      ...valid,
      weights: { ...valid.weights, projection: 1.2 },
    };
    expect(() => parseCpuPersonalitySnapshot(outOfBounds)).toThrow();

    const negative = {
      ...valid,
      weights: { ...valid.weights, adpValue: -0.1 },
    };
    expect(() => parseCpuPersonalitySnapshot(negative)).toThrow();

    const badSum = {
      ...valid,
      weights: { ...valid.weights, projection: valid.weights.projection + 0.05 },
    };
    expect(() => parseCpuPersonalitySnapshot(badSum)).toThrow();

    expect(() => parseCpuPersonalitySnapshot({ ...valid, weights: undefined })).toThrow();
  });

  it("checksums are stable across re-parse and change when any weight changes", () => {
    const valid = snapshotOf("upside-hunter");
    const reparsed = parseCpuPersonalitySnapshot(JSON.parse(JSON.stringify(valid)) as unknown);
    expect(checksumCpuPersonalitySnapshot(reparsed)).toBe(checksumCpuPersonalitySnapshot(valid));

    const nudged = parseCpuPersonalitySnapshot({
      ...valid,
      weights: {
        ...valid.weights,
        upside: valid.weights.upside + 0.01,
        safety: valid.weights.safety - 0.01,
      },
    });
    expect(nudged.weights.upside).not.toBe(valid.weights.upside);
    expect(checksumCpuPersonalitySnapshot(nudged)).not.toBe(checksumCpuPersonalitySnapshot(valid));

    // Non-weight identity changes also move the content checksum.
    const relabeled = parseCpuPersonalitySnapshot({ ...valid, key: "adp-follower" });
    expect(checksumCpuPersonalitySnapshot(relabeled)).not.toBe(
      checksumCpuPersonalitySnapshot(valid),
    );
  });
});
