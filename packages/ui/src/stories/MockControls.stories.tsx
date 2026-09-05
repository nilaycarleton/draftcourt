import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import {
  MockPersonalityPicker,
  type CpuPersonalityOption,
} from "../components/MockPersonalityPicker";

/**
 * Stories render without the consuming app's stylesheet (the canonical
 * dc-mock-* rules live in apps/web/app/phase3c-mock.css and cannot be
 * imported across the package boundary), so a minimal scoped copy of those
 * rules is injected per story below. Keep in sync with the app file.
 */

const STORY_STYLES = `
.dc-mock-personality-picker { border: 0; display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; }
.dc-mock-personality-legend { font-weight: 600; padding: 0; }
.dc-mock-personality-option { align-items: center; border-bottom: 1px solid rgba(128,128,128,.25); column-gap: 8px; display: flex; min-height: 44px; padding: 8px 0; }
.dc-mock-personality-option input[type="radio"] { accent-color: var(--dc-color-accent, #b24a00); block-size: 44px; inline-size: 20px; margin: 0; }
.dc-mock-personality-option-title { font-weight: 600; }
.dc-mock-personality-option-description { color: var(--dc-color-text-secondary, inherit); flex-basis: 100%; font-size: .875rem; order: 3; }
.dc-mock-personality-option-key { color: var(--dc-color-text-muted, inherit); flex-basis: 100%; font-family: ui-monospace, monospace; font-size: .75rem; order: 4; }
.dc-mock-controls { align-items: flex-start; border-top: 1px solid rgba(128,128,128,.25); display: flex; flex-wrap: wrap; gap: 12px; margin-top: 12px; max-width: 720px; padding-top: 12px; }
.dc-mock-speed-group { align-items: center; border: 1px solid rgba(128,128,128,.3); border-radius: 8px; display: flex; flex-wrap: wrap; gap: 4px 12px; padding: 8px 12px; }
.dc-mock-speed-group legend { font-size: .875rem; font-weight: 600; padding: 0 4px; }
.dc-mock-speed-option { align-items: center; display: flex; min-height: 44px; }
.dc-mock-speed-option input[type="radio"] { accent-color: var(--dc-color-accent, #b24a00); height: 44px; margin: 0; width: 24px; }
.dc-mock-switch { align-items: center; background: none; border: none; color: inherit; cursor: pointer; display: flex; gap: 8px; min-height: 44px; padding: 4px 8px; }
.dc-mock-switch-track { background: var(--dc-color-border-strong, currentColor); border-radius: 999px; display: inline-block; height: 18px; position: relative; width: 34px; }
.dc-mock-switch-track::after { background: var(--dc-color-surface-elevated, #fff); border-radius: 999px; content: ""; height: 14px; left: 2px; position: absolute; top: 2px; transition: none; width: 14px; }
.dc-mock-switch-track[data-on] { background: var(--dc-color-accent, #b24a00); }
.dc-mock-switch-track[data-on]::after { transform: translateX(16px); }
.dc-mock-controls-progress { color: var(--dc-color-text-secondary, inherit); flex: 1 1 200px; font-size: .875rem; margin: 0; }
.dc-mock-actions { display: flex; gap: 8px; }
.dc-mock-action-button { background: none; border: 1px solid var(--dc-color-border-strong, currentColor); border-radius: 8px; color: inherit; cursor: pointer; min-height: 44px; min-width: 44px; padding: 0 12px; }
.dc-mock-action-button:disabled { cursor: not-allowed; opacity: .55; }
`;

function StoryFrame({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 16 }}>
      <style>{STORY_STYLES}</style>
      {children}
    </div>
  );
}

/**
 * Phase 3C stories: CPU personality picker states plus mock-control states
 * (idle / cpuAdvancing / paused / completing / error).
 *
 * The picker is imported from this package. The web-side MockDraftControls
 * lives under apps/web, which this package's tsconfig rootDir cannot import,
 * so the control-state demos render a faithful in-file mirror of its markup
 * and dc-* classes — kept visually in sync with
 * apps/web/features/drafts/MockDraftControls.tsx (see the Phase 3C report).
 */

const meta: Meta = {
  title: "Mock Controls",
  parameters: { layout: "padded" },
};
export default meta;

const PERSONALITIES: CpuPersonalityOption[] = [
  {
    key: "playmaker",
    title: "Playmaker",
    description: "Chases high-assist playmakers early.",
  },
  {
    key: "risk-taker",
    title: "Risk Taker",
    description: "Reaches for upside; tolerates bust weeks.",
  },
  {
    key: "safe-hands",
    title: "Safe Hands",
    description: "Prefers durable, consistent floor players.",
  },
];

function PickerDemo({ initial }: { initial: string | null }) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <div style={{ maxWidth: 480 }}>
      <MockPersonalityPicker personalities={PERSONALITIES} value={value} onChange={setValue} />
    </div>
  );
}

export const PersonalityDefaultFirstOption: StoryObj = {
  render: () => (
    <StoryFrame>
      <PickerDemo initial="playmaker" />
    </StoryFrame>
  ),
};

export const PersonalityFollowDefault: StoryObj = {
  render: () => (
    <StoryFrame>
      <PickerDemo initial={null} />
    </StoryFrame>
  ),
};

export const PersonalityEmptyCatalog: StoryObj = {
  render: () => (
    <StoryFrame>
      <div style={{ maxWidth: 480 }}>
        <MockPersonalityPicker personalities={[]} value={null} onChange={() => undefined} />
      </div>
    </StoryFrame>
  ),
};

export const PersonalityDisabled: StoryObj = {
  render: () => (
    <StoryFrame>
      <div style={{ maxWidth: 480 }}>
        <MockPersonalityPicker
          personalities={PERSONALITIES}
          value="safe-hands"
          onChange={() => undefined}
          disabled
        />
      </div>
    </StoryFrame>
  ),
};

/* ----- Control-state mirrors (see header note) ---------------------------- */

const SPEEDS = [
  { key: "SLOW", label: "Slow" },
  { key: "NORMAL", label: "Normal" },
  { key: "INSTANT", label: "Instant" },
] as const;

interface ControlMirrorProps {
  phase: string;
  progressText: string;
  advancing: boolean;
  canAdvance: boolean;
}

/** Markup/classes mirror apps/web/features/drafts/MockDraftControls.tsx. */
function ControlStateDemo({ phase, progressText, advancing, canAdvance }: ControlMirrorProps) {
  return (
    <div role="group" aria-label="Mock draft controls" className="dc-mock-controls">
      <fieldset className="dc-mock-speed-group">
        <legend>Speed</legend>
        {SPEEDS.map((speed) => (
          <label key={speed.key} className="dc-mock-speed-option">
            <input
              type="radio"
              name={`dc-mock-speed-${phase}`}
              value={speed.key}
              defaultChecked={speed.key === "NORMAL"}
            />
            <span className="dc-mock-speed-label">{speed.label}</span>
          </label>
        ))}
      </fieldset>
      <button
        type="button"
        role="switch"
        aria-checked={phase === "cpuAdvancing"}
        className="dc-mock-switch"
      >
        <span
          aria-hidden="true"
          className="dc-mock-switch-track"
          data-on={phase === "cpuAdvancing" || undefined}
        />
        <span className="dc-mock-switch-label">Auto-advance</span>
      </button>
      <p aria-live="off" className="dc-mock-controls-progress">
        {progressText}
      </p>
      <div className="dc-mock-actions">
        {advancing ? (
          <button type="button" className="dc-mock-action-button">
            Cancel
          </button>
        ) : (
          <button type="button" className="dc-mock-action-button" disabled={!canAdvance}>
            Advance
          </button>
        )}
        {phase === "cpuAdvancing" && (
          <button type="button" className="dc-mock-action-button">
            Pause
          </button>
        )}
        {phase === "paused" && (
          <button type="button" className="dc-mock-action-button">
            Resume
          </button>
        )}
      </div>
    </div>
  );
}

export const ControlsIdle: StoryObj = {
  render: () => (
    <StoryFrame>
      <ControlStateDemo
        phase="idle"
        progressText="Mock controls ready."
        advancing={false}
        canAdvance
      />
    </StoryFrame>
  ),
};

export const ControlsCpuAdvancing: StoryObj = {
  render: () => (
    <StoryFrame>
      <ControlStateDemo
        phase="cpuAdvancing"
        progressText="CPU drafted Franz Wagner — overall pick 7 is next."
        advancing
        canAdvance={false}
      />
    </StoryFrame>
  ),
};

export const ControlsPaused: StoryObj = {
  render: () => (
    <StoryFrame>
      <ControlStateDemo
        phase="paused"
        progressText="Auto-advance paused."
        advancing={false}
        canAdvance
      />
    </StoryFrame>
  ),
};

export const ControlsCompleting: StoryObj = {
  render: () => (
    <StoryFrame>
      <ControlStateDemo
        phase="completing"
        progressText="Draft complete — Jaylen Brown was the final pick."
        advancing={false}
        canAdvance={false}
      />
    </StoryFrame>
  ),
};

export const ControlsError: StoryObj = {
  render: () => (
    <StoryFrame>
      <ControlStateDemo
        phase="error"
        progressText="Out-of-date board detected — re-synced. Advance again."
        advancing={false}
        canAdvance
      />
    </StoryFrame>
  ),
};
