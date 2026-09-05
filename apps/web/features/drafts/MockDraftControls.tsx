"use client";

import { MOCK_SPEED_MS, type MockPacingSpeed } from "./mockPacing";
import type { MockRunnerController } from "./useMockRunner";

/**
 * Presentational mock-draft control cluster (Phase 3C): pacing speed
 * radiogroup, auto-advance switch, Advance ↔ Cancel, Pause/Resume and an
 * aria-live="off" progress line (the room's polite region owns spoken
 * announcements so bursts stay quiet). All behaviour arrives via props.
 */

export interface MockDraftControlsProps {
  phase: MockRunnerController["phase"];
  progressText: string;
  advancing: boolean;
  canAdvance: boolean;
  speed: MockPacingSpeed;
  autoAdvance: boolean;
  disabled?: boolean | undefined;
  onSpeedChange: (speed: MockPacingSpeed) => void;
  onAutoAdvanceChange: (enabled: boolean) => void;
  onAdvance: () => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
}

const SPEED_LABELS: Record<MockPacingSpeed, string> = {
  SLOW: "Slow",
  NORMAL: "Normal",
  INSTANT: "Instant",
};

const SPEED_ORDER: readonly MockPacingSpeed[] = ["SLOW", "NORMAL", "INSTANT"];

function speedHint(speed: MockPacingSpeed): string {
  const ms = MOCK_SPEED_MS[speed];
  return ms >= 1000
    ? `${String(ms / 1000)}s between CPU picks`
    : `${String(ms)}ms between CPU picks`;
}

export function MockDraftControls({
  phase,
  progressText,
  advancing,
  canAdvance,
  speed,
  autoAdvance,
  disabled = false,
  onSpeedChange,
  onAutoAdvanceChange,
  onAdvance,
  onPause,
  onResume,
  onCancel,
}: MockDraftControlsProps): React.JSX.Element {
  return (
    <div role="group" aria-label="Mock draft controls" className="dc-mock-controls">
      <fieldset className="dc-mock-speed-group" disabled={disabled}>
        <legend>Speed</legend>
        {SPEED_ORDER.map((speedKey) => (
          <label key={speedKey} className="dc-mock-speed-option">
            <input
              type="radio"
              name="dc-mock-speed"
              value={speedKey}
              checked={speed === speedKey}
              disabled={disabled}
              onChange={() => {
                onSpeedChange(speedKey);
              }}
            />
            <span className="dc-mock-speed-label" title={speedHint(speedKey)}>
              {SPEED_LABELS[speedKey]}
            </span>
          </label>
        ))}
      </fieldset>

      <button
        type="button"
        role="switch"
        aria-checked={autoAdvance}
        className="dc-mock-switch"
        disabled={disabled}
        onClick={() => {
          onAutoAdvanceChange(!autoAdvance);
        }}
      >
        <span
          aria-hidden="true"
          className="dc-mock-switch-track"
          data-on={autoAdvance || undefined}
        />
        <span className="dc-mock-switch-label">Auto-advance</span>
      </button>

      <p aria-live="off" className="dc-mock-controls-progress">
        {progressText}
      </p>

      <div className="dc-mock-actions">
        {advancing ? (
          <button
            type="button"
            className="dc-mock-action-button"
            disabled={disabled}
            onClick={onCancel}
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            className="dc-mock-action-button"
            disabled={disabled || !canAdvance}
            onClick={onAdvance}
          >
            Advance
          </button>
        )}
        {phase === "cpuAdvancing" && (
          <button
            type="button"
            className="dc-mock-action-button"
            disabled={disabled}
            onClick={onPause}
          >
            Pause
          </button>
        )}
        {phase === "paused" && (
          <button
            type="button"
            className="dc-mock-action-button"
            disabled={disabled}
            onClick={onResume}
          >
            Resume
          </button>
        )}
      </div>
    </div>
  );
}
