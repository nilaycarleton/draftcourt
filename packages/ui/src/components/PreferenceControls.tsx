"use client";

import { useId, type ChangeEvent } from "react";

/**
 * Preference-control primitives for `/preferences` (Phase 3A). Presentational
 * and controlled — all strategy logic lives in the domain package and the
 * web feature layer. Touch targets ≥ 44×44 CSS px; every control is
 * natively focusable and labeled.
 */

export interface FactorSliderRowProps {
  label: string;
  /** 0..1, rendered as a percentage with tabular numerals. */
  value: number;
  locked?: boolean;
  disabled?: boolean;
  showLock?: boolean;
  onValueChange: (value: number) => void;
  onToggleLock?: () => void;
}

const PERCENT = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 1,
});

export function FactorSliderRow({
  label,
  value,
  locked = false,
  disabled = false,
  showLock = true,
  onValueChange,
  onToggleLock,
}: FactorSliderRowProps): React.JSX.Element {
  const id = useId();
  const clamped = Math.min(Math.max(value, 0), 1);
  return (
    <div className="dc-factor-row">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="range"
        min={0}
        max={1}
        step={0.005}
        value={clamped}
        disabled={disabled || locked}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={PERCENT.format(clamped)}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          onValueChange(Number(event.target.value));
        }}
      />
      <output className="dc-factor-value" htmlFor={id}>
        {PERCENT.format(clamped)}
      </output>
      {showLock ? (
        <button
          type="button"
          className="dc-lock-button"
          aria-pressed={locked}
          aria-label={`${locked ? "Unlock" : "Lock"} ${label}`}
          disabled={disabled}
          onClick={onToggleLock}
        >
          {locked ? "🔒" : "🔓"}
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}

export interface PresetGalleryItem {
  key: string;
  title: string;
  explanation: string;
}

export interface PresetGalleryProps {
  presets: PresetGalleryItem[];
  /** Key of the preset that produced the current settings (provenance). */
  activeKey?: string | null;
  disabled?: boolean;
  onApply: (key: string) => void;
}

export function PresetGallery({
  presets,
  activeKey = null,
  disabled = false,
  onApply,
}: PresetGalleryProps): React.JSX.Element {
  return (
    <div className="dc-preset-grid" role="group" aria-label="Strategy presets">
      {presets.map((preset) => (
        <button
          key={preset.key}
          type="button"
          className="dc-preset-card"
          aria-pressed={activeKey === preset.key}
          disabled={disabled}
          onClick={() => {
            onApply(preset.key);
          }}
        >
          <strong>{preset.title}</strong>
          <small>{preset.explanation}</small>
        </button>
      ))}
    </div>
  );
}

export interface RankListEditorItem {
  playerId: string;
  displayName: string;
}

export interface RankListEditorProps {
  items: RankListEditorItem[];
  notes: Record<string, string>;
  disabled?: boolean;
  labelId: string;
  onMove: (playerId: string, direction: "up" | "down") => void;
  onRemove: (playerId: string) => void;
  onNoteChange: (playerId: string, note: string) => void;
}

/** Dense personal big board. Reordering is fully keyboard-operable via
 * explicit Move up / Move down buttons — drag-and-drop is never required. */
export function RankListEditor({
  items,
  notes,
  disabled = false,
  labelId,
  onMove,
  onRemove,
  onNoteChange,
}: RankListEditorProps): React.JSX.Element {
  return (
    <ol className="dc-rank-list" aria-labelledby={labelId}>
      {items.map((item, index) => (
        <li key={item.playerId} className="dc-rank-row">
          <span className="dc-rank-index" aria-hidden="true">
            {index + 1}.
          </span>
          <span className="dc-rank-player" title={item.displayName}>
            {item.displayName}
          </span>
          <button
            type="button"
            className="dc-mini-button"
            disabled={disabled || index === 0}
            aria-label={`Move ${item.displayName} up to position ${String(index)}`}
            onClick={() => {
              onMove(item.playerId, "up");
            }}
          >
            ↑
          </button>
          <button
            type="button"
            className="dc-mini-button"
            disabled={disabled || index === items.length - 1}
            aria-label={`Move ${item.displayName} down to position ${String(index + 2)}`}
            onClick={() => {
              onMove(item.playerId, "down");
            }}
          >
            ↓
          </button>
          <input
            type="number"
            min={1}
            max={10}
            className="dc-rank-tier"
            aria-label={`Tier for ${item.displayName} (1–10)`}
            placeholder="Tier"
            disabled={disabled}
            value={notes[`${item.playerId}:tier`] ?? ""}
            onChange={(event) => {
              onNoteChange(`${item.playerId}:tier`, event.target.value);
            }}
            style={{ maxWidth: 84 }}
          />
          <input
            type="text"
            className="dc-rank-note"
            aria-label={`Note for ${item.displayName}`}
            placeholder="Note (optional)"
            maxLength={280}
            disabled={disabled}
            value={notes[item.playerId] ?? ""}
            onChange={(event) => {
              onNoteChange(item.playerId, event.target.value);
            }}
          />
          <button
            type="button"
            className="dc-mini-button"
            disabled={disabled}
            aria-label={`Remove ${item.displayName} from board`}
            onClick={() => {
              onRemove(item.playerId);
            }}
          >
            ✕
          </button>
        </li>
      ))}
    </ol>
  );
}
