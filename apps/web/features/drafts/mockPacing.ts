/**
 * Mock-draft pacing preferences (Phase 3C). Shared by /drafts/new (where the
 * user picks speed/auto-advance) and the draft room (where the mock runner
 * consumes them). Persisted in localStorage so the room inherits what the
 * start flow saved. All access is SSR-safe: server calls get defaults and
 * never touch `window`.
 */

export type MockPacingSpeed = "SLOW" | "NORMAL" | "INSTANT";

/** Delay between automatic CPU picks, in milliseconds. */
export const MOCK_SPEED_MS: Record<MockPacingSpeed, number> = {
  SLOW: 10_000,
  NORMAL: 3_500,
  INSTANT: 250,
};

export interface MockPacingSettings {
  speed: MockPacingSpeed;
  autoAdvance: boolean;
}

export const DEFAULT_MOCK_PACING: MockPacingSettings = {
  speed: "NORMAL",
  autoAdvance: false,
};

const STORAGE_KEY = "dc.mock.pacing";

const SPEED_VALUES: readonly MockPacingSpeed[] = ["SLOW", "NORMAL", "INSTANT"];

function isMockPacingSpeed(value: unknown): value is MockPacingSpeed {
  return typeof value === "string" && SPEED_VALUES.includes(value as MockPacingSpeed);
}

export function readMockPacing(): MockPacingSettings {
  if (typeof window === "undefined") return { ...DEFAULT_MOCK_PACING };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return { ...DEFAULT_MOCK_PACING };
    const parsed = JSON.parse(raw) as Partial<MockPacingSettings> | null;
    return {
      speed:
        parsed !== null && isMockPacingSpeed(parsed.speed)
          ? parsed.speed
          : DEFAULT_MOCK_PACING.speed,
      autoAdvance:
        parsed !== null && typeof parsed.autoAdvance === "boolean"
          ? parsed.autoAdvance
          : DEFAULT_MOCK_PACING.autoAdvance,
    };
  } catch {
    // Corrupt JSON or a blocked storage area — defaults are always safe.
    return { ...DEFAULT_MOCK_PACING };
  }
}

export function writeMockPacing(settings: MockPacingSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private-mode/quota failures keep settings session-only; never fatal.
  }
}

export function mockDelayMs(speed: MockPacingSpeed): number {
  return MOCK_SPEED_MS[speed];
}
