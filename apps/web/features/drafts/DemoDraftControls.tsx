"use client";

import type { useDemoRunner, DemoPacingSpeed } from "./useDemoRunner";

interface DemoDraftControlsProps {
  runner: ReturnType<typeof useDemoRunner>;
  draftStatus: string;
  userTurn: boolean;
  cpuTeam: { slot: number; personalityKey: string | null } | null;
  onCancel: () => void;
}

export function DemoDraftControls({
  runner,
  draftStatus,
  userTurn,
  cpuTeam,
  onCancel,
}: DemoDraftControlsProps) {
  const { state, advanceOneCpu, cancel, setSpeed, toggleAutoAdvance } = runner;

  const isActive = draftStatus === "ACTIVE";
  const isCompleted = draftStatus === "COMPLETED";
  const isExpired = state.status === "expired";
  const isError = state.status === "error";

  if (!isActive && !isCompleted) {
    return (
      <div className="dc-demo-controls" role="status" aria-live="polite">
        {isExpired && (
          <div className="dc-demo-banner dc-demo-expired">
            This demo has expired (24-hour limit).{" "}
            <button onClick={onCancel}>Return to demo</button>
          </div>
        )}
        {isError && (
          <div className="dc-demo-banner dc-demo-error">
            Error: {state.lastError}{" "}
            <button
              onClick={() => {
                void advanceOneCpu();
              }}
            >
              Retry
            </button>
          </div>
        )}
      </div>
    );
  }

  const speedLabels: Record<DemoPacingSpeed, string> = {
    SLOW: "Slow",
    NORMAL: "Normal",
    INSTANT: "Instant",
  };

  return (
    <div className="dc-demo-controls">
      <div className="dc-demo-status" role="status" aria-live="polite">
        {isCompleted ? (
          <span className="dc-demo-complete">✓ Demo draft completed</span>
        ) : cpuTeam ? (
          <>
            <span>CPU Team {cpuTeam.slot}</span>
            {cpuTeam.personalityKey && (
              <span className="dc-personality-badge">{cpuTeam.personalityKey}</span>
            )}
            {userTurn && <span className="dc-user-turn">Your turn</span>}
          </>
        ) : (
          <span>Waiting…</span>
        )}
        <span className="dc-demo-progress">
          {state.progress.current} / {state.progress.total} picks
        </span>
      </div>

      <fieldset className="dc-demo-pacing" disabled={!isActive || userTurn}>
        <legend>Simulation Speed</legend>
        <div className="dc-speed-radios" role="radiogroup" aria-label="Simulation speed">
          {(["SLOW", "NORMAL", "INSTANT"] as DemoPacingSpeed[]).map((speed) => (
            <label key={speed} className="dc-speed-option">
              <input
                type="radio"
                name="dc-demo-speed"
                value={speed}
                checked={state.speed === speed}
                onChange={() => {
                  setSpeed(speed);
                }}
                disabled={!isActive || userTurn}
              />
              <span>{speedLabels[speed]}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="dc-demo-actions">
        {isActive && userTurn ? (
          <span className="dc-demo-hint">Make your pick to continue</span>
        ) : isActive && !userTurn ? (
          <>
            <button
              type="button"
              className="dc-button-secondary"
              onClick={() => {
                void advanceOneCpu();
              }}
              disabled={state.status === "running"}
            >
              {state.status === "running" ? "Advancing…" : "Advance CPU"}
            </button>
            <label className="dc-auto-advance-toggle">
              <input
                type="checkbox"
                checked={state.autoAdvance}
                onChange={() => {
                  toggleAutoAdvance();
                }}
                disabled={state.status === "running"}
              />
              <span>Auto-advance</span>
            </label>
          </>
        ) : isCompleted ? (
          <button type="button" className="dc-button-secondary" onClick={onCancel}>
            Return to Demo
          </button>
        ) : null}
        {(isActive || isCompleted) && (
          <button type="button" className="dc-button-ghost" onClick={cancel}>
            {state.autoAdvance ? "Pause" : "Cancel"}
          </button>
        )}
      </div>

      {state.lastError && (
        <div className="dc-demo-error" role="alert">
          {state.lastError}
          <button
            type="button"
            onClick={() => {
              void advanceOneCpu();
            }}
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
