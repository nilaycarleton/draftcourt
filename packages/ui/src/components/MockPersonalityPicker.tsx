"use client";

import { useId } from "react";

/**
 * Presentational radiogroup for choosing a CPU mock-draft personality
 * (Phase 3C). Controlled and logic-free — the catalog arrives as plain
 * props, selection state lives in the caller. Native radio inputs keep
 * arrow-key/roving focus behaviour for free; "Follow default" is expressed
 * as a `null` value rather than a magic string.
 */

export interface CpuPersonalityOption {
  /** Stable catalog key sent to the server (`cpuPersonalityKey`). */
  key: string;
  /** Human title shown on the option row. */
  title: string;
  /** One-line behavioural description shown under the title. */
  description: string;
}

export interface MockPersonalityPickerProps {
  personalities: CpuPersonalityOption[];
  /** Selected personality key, or null when "Follow default" is chosen. */
  value: string | null;
  onChange: (key: string | null) => void;
  /** Group label rendered as the fieldset legend. */
  label?: string;
  disabled?: boolean;
}

export function MockPersonalityPicker({
  personalities,
  value,
  onChange,
  label = "CPU personality",
  disabled = false,
}: MockPersonalityPickerProps): React.JSX.Element {
  const groupName = useId();
  return (
    <fieldset className="dc-mock-personality-picker" disabled={disabled}>
      <legend className="dc-mock-personality-legend">{label}</legend>
      <label
        className="dc-mock-personality-option"
        data-follow="true"
        data-checked={value === null || undefined}
      >
        <input
          type="radio"
          name={groupName}
          checked={value === null}
          disabled={disabled}
          onChange={() => {
            onChange(null);
          }}
        />
        <span className="dc-mock-personality-option-title">Follow default</span>
        <span className="dc-mock-personality-option-description">
          Every CPU team uses the league&rsquo;s default behaviour.
        </span>
      </label>
      {personalities.map((option) => (
        <label
          key={option.key}
          className="dc-mock-personality-option"
          data-checked={value === option.key || undefined}
        >
          <input
            type="radio"
            name={groupName}
            value={option.key}
            checked={value === option.key}
            disabled={disabled}
            onChange={() => {
              onChange(option.key);
            }}
          />
          <span className="dc-mock-personality-option-title">{option.title}</span>
          <span className="dc-mock-personality-option-description">{option.description}</span>
          <span className="dc-mock-personality-option-key">{option.key}</span>
        </label>
      ))}
    </fieldset>
  );
}
