import { describe, expect, it } from "vitest";
import { defaultPreferenceSettings } from "./preferences";
import {
  checksumPreferenceSnapshot,
  parseDraftPreferenceSnapshot,
  toEnginePreferences,
  type DraftPreferenceSnapshot,
} from "./recommendation-snapshot";

function baseSnapshot(): DraftPreferenceSnapshot {
  return {
    snapshotVersion: 1,
    source: {
      kind: "LEAGUE_SELECTION",
      profileId: "01890a5d-ac96-774b-bcce-b302099a8057",
      profileName: "My Strategy",
      presetKey: "win-now",
      presetVersion: 1,
    },
    preferenceSchemaVersion: 1,
    settings: defaultPreferenceSettings(),
    playerEntries: [
      { playerId: "player-b", listType: "TARGET", magnitude: 0.8 },
      { playerId: "player-a", listType: "AVOID", magnitude: -1 },
    ],
    teamEntries: [{ teamId: "team-1", type: "FAVORITE", magnitude: 0.5 }],
    customRanks: {
      global: [
        { playerId: "p2", rank: 2 },
        { playerId: "p1", rank: 1 },
      ],
      league: [{ playerId: "p2", rank: 9 }],
    },
    capturedAt: "2026-08-24T00:00:00.000Z",
  };
}

describe("draft preference snapshots", () => {
  it("hashes identically for canonically equivalent content", () => {
    const a = baseSnapshot();
    const b = baseSnapshot();
    b.playerEntries = [...b.playerEntries].reverse();
    b.teamEntries = [...b.teamEntries];
    b.customRanks.global = [...b.customRanks.global].reverse();
    b.settings.positionPriorities = [
      { position: "C", priority: 0.4 },
      { position: "PG", priority: 1 },
    ];
    a.settings.positionPriorities = [
      { position: "PG", priority: 1 },
      { position: "C", priority: 0.4 },
    ];
    b.capturedAt = "2099-01-01T12:00:00.000Z";
    b.source.profileName = "Renamed Later";

    expect(checksumPreferenceSnapshot(b)).toBe(checksumPreferenceSnapshot(a));
  });

  it("changes the checksum when strategy content changes", () => {
    const a = baseSnapshot();
    const weightShift = baseSnapshot();
    weightShift.settings.factorWeights.production =
      weightShift.settings.factorWeights.production + 0.000001 > 1
        ? weightShift.settings.factorWeights.production - 0.000001
        : weightShift.settings.factorWeights.production + 0.000001;
    expect(checksumPreferenceSnapshot(weightShift)).not.toBe(checksumPreferenceSnapshot(a));

    const avoidMode = baseSnapshot();
    avoidMode.settings.avoidMode = "SEVERE_PENALTY";
    expect(checksumPreferenceSnapshot(avoidMode)).not.toBe(checksumPreferenceSnapshot(a));

    const rankChange = baseSnapshot();
    const leagueEntry = rankChange.customRanks.league[0];
    if (leagueEntry !== undefined) {
      leagueEntry.rank = leagueEntry.rank === 9 ? 10 : 9;
    }
    expect(checksumPreferenceSnapshot(rankChange)).not.toBe(checksumPreferenceSnapshot(a));

    const sourceKind = baseSnapshot();
    sourceKind.source.kind = "USER_DEFAULT";
    expect(checksumPreferenceSnapshot(sourceKind)).not.toBe(checksumPreferenceSnapshot(a));
  });

  it("projects one resolved entry per player with severity precedence", () => {
    const snapshot = baseSnapshot();
    snapshot.playerEntries.push({ playerId: "player-a", listType: "FAVORITE", magnitude: 1 });
    const prefs = toEnginePreferences(snapshot);

    // AVOID outranks FAVORITE for the same player.
    expect(prefs.playerEntries["player-a"]).toEqual({
      listType: "AVOID",
      magnitude: -1,
    });
    expect(prefs.playerEntries["player-b"]).toEqual({
      listType: "TARGET",
      magnitude: 0.8,
    });
  });

  it("merges custom ranks with league overriding global", () => {
    const prefs = toEnginePreferences(baseSnapshot());
    // p2 exists in both scopes; league rank wins.
    expect(prefs.customRanks.p2).toBe(9);
    expect(prefs.customRanks.p1).toBe(1);
  });

  it("carries scalars, priorities, and versions into the engine input", () => {
    const snapshot = baseSnapshot();
    snapshot.settings.riskTolerance = 0.2;
    snapshot.settings.schedule = { enabled: true, playoffWeeks: 3 };
    const prefs = toEnginePreferences(snapshot);
    expect(prefs.snapshotVersion).toBe(1);
    expect(prefs.preferenceSchemaVersion).toBe(1);
    expect(prefs.riskTolerance).toBe(0.2);
    expect(prefs.schedule).toEqual({ enabled: true, playoffWeeks: 3 });
    expect(Object.values(prefs.factorWeights).reduce((x, y) => x + y, 0)).toBeCloseTo(1, 6);
  });

  it("fails closed on unknown snapshot versions or malformed payloads", () => {
    const bad = baseSnapshot() as unknown as Record<string, unknown>;
    bad.snapshotVersion = 99;
    expect(() => parseDraftPreferenceSnapshot(bad)).toThrow();

    const negativeFavorite = baseSnapshot();
    negativeFavorite.playerEntries[1] = { playerId: "x", listType: "TARGET", magnitude: -0.5 };
    expect(() => parseDraftPreferenceSnapshot(negativeFavorite)).toThrow();
  });
});
