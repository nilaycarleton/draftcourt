"use client";

import { useMemo } from "react";

/**
 * Presentational draft-replay primitives (Phase 3E2).
 *
 * Logic-free and controlled: position/playback state lives in the caller
 * (`ReplaySection` / `SharedReplay` in `apps/web`), so keyboard, scrubber,
 * and playback always derive from one source. All buttons expose disabled
 * states and accessible names; the scrubber has an explicit name + value
 * text. Class names are `dc-replay-*` / `dc-timeline-*`, styled by the web
 * app's `phase3e-results.css` (same split as the mock/personality controls).
 */

export type ReplayTransportSpeed = 1 | 2;

export interface ReplayTransportProps {
  position: number;
  total: number;
  playing: boolean;
  speed: ReplayTransportSpeed;
  disabled?: boolean;
  onFirst: () => void;
  onPrevious: () => void;
  onTogglePlay: () => void;
  onNext: () => void;
  onLast: () => void;
  onSpeedChange: (speed: ReplayTransportSpeed) => void;
  onScrub: (sequence: number) => void;
}

export function ReplayTransport(props: ReplayTransportProps): React.JSX.Element {
  const { position, total, playing, speed, disabled = false } = props;
  const atFirst = position <= 0 || disabled;
  const atLast = position >= total - 1 || disabled;

  return (
    <div className="dc-replay-controls" role="group" aria-label="Draft replay controls">
      <div className="dc-replay-transport">
        <button
          type="button"
          className="dc-button-secondary dc-replay-button"
          aria-label="First event"
          disabled={atFirst}
          onClick={props.onFirst}
        >
          ⏮<span className="dc-visually-hidden">First</span>
        </button>
        <button
          type="button"
          className="dc-button-secondary dc-replay-button"
          aria-label="Previous event"
          disabled={atFirst}
          onClick={props.onPrevious}
        >
          ◀<span className="dc-visually-hidden">Previous</span>
        </button>
        <button
          type="button"
          className="dc-button-primary dc-replay-button"
          aria-label={playing ? "Pause replay" : "Play replay"}
          aria-pressed={playing}
          disabled={disabled || total === 0}
          onClick={props.onTogglePlay}
        >
          {playing ? "❚❚" : "▶"}
          <span className="dc-visually-hidden">{playing ? "Pause" : "Play"}</span>
        </button>
        <button
          type="button"
          className="dc-button-secondary dc-replay-button"
          aria-label="Next event"
          disabled={atLast}
          onClick={props.onNext}
        >
          ▶<span className="dc-visually-hidden">Next</span>
        </button>
        <button
          type="button"
          className="dc-button-secondary dc-replay-button"
          aria-label="Last event"
          disabled={atLast}
          onClick={props.onLast}
        >
          ⏭<span className="dc-visually-hidden">Last</span>
        </button>
        <div className="dc-replay-speed" role="group" aria-label="Playback speed">
          <button
            type="button"
            className="dc-button-secondary dc-replay-speed-button"
            aria-pressed={speed === 1}
            aria-label="Playback speed 1x"
            disabled={disabled}
            onClick={() => {
              props.onSpeedChange(1);
            }}
          >
            1×
          </button>
          <button
            type="button"
            className="dc-button-secondary dc-replay-speed-button"
            aria-pressed={speed === 2}
            aria-label="Playback speed 2x"
            disabled={disabled}
            onClick={() => {
              props.onSpeedChange(2);
            }}
          >
            2×
          </button>
        </div>
      </div>
      <div className="dc-replay-scrub-row">
        <label className="dc-replay-scrub-label" htmlFor="dc-replay-scrub">
          Replay position
        </label>
        <input
          id="dc-replay-scrub"
          className="dc-replay-scrub"
          type="range"
          min={0}
          max={Math.max(total - 1, 0)}
          step={1}
          value={Math.min(position, Math.max(total - 1, 0))}
          disabled={disabled || total === 0}
          aria-valuetext={
            total === 0 ? "No events" : `Event ${String(position + 1)} of ${String(total)}`
          }
          onChange={(event) => {
            props.onScrub(Number(event.target.value));
          }}
        />
        <output className="dc-replay-count" htmlFor="dc-replay-scrub" aria-live="off">
          {total === 0 ? "No events" : `Event ${String(position + 1)} of ${String(total)}`}
        </output>
      </div>
    </div>
  );
}

export interface ReplayTimelineEntry {
  sequence: number;
  description: string;
  actorType: string;
  eventType: string;
}

export interface ReplayTimelineProps {
  entries: ReplayTimelineEntry[];
  position: number;
  onSelect: (index: number) => void;
}

const TIMELINE_WINDOW_RADIUS = 60;

export function ReplayTimeline({
  entries,
  position,
  onSelect,
}: ReplayTimelineProps): React.JSX.Element {
  const windowed = useMemo(() => {
    if (entries.length <= TIMELINE_WINDOW_RADIUS * 2 + 1) {
      return { start: 0, rows: entries.map((entry, index) => ({ entry, index })) };
    }
    const start = Math.max(
      0,
      Math.min(
        position - TIMELINE_WINDOW_RADIUS,
        entries.length - (TIMELINE_WINDOW_RADIUS * 2 + 1),
      ),
    );
    const end = Math.min(entries.length, start + TIMELINE_WINDOW_RADIUS * 2 + 1);
    return {
      start,
      rows: entries.slice(start, end).map((entry, offset) => ({ entry, index: start + offset })),
    };
  }, [entries, position]);

  if (entries.length === 0) {
    return <p className="dc-hint">No events recorded for this draft.</p>;
  }

  return (
    <div className="dc-timeline-wrap">
      <p className="dc-hint" aria-live="off">
        Showing {String(windowed.rows.length)} of {String(entries.length)} events
        {windowed.start > 0 ? ` (from event ${String(windowed.start + 1)})` : ""}.
      </p>
      <ol className="dc-timeline" aria-label="Draft event timeline">
        {windowed.rows.map(({ entry, index }) => {
          const current = index === position;
          return (
            <li key={entry.sequence} className="dc-timeline-row">
              <button
                type="button"
                className="dc-timeline-button"
                aria-current={current ? "true" : undefined}
                aria-label={`${entry.description}${current ? " (current)" : ""}`}
                onClick={() => {
                  onSelect(index);
                }}
              >
                <span className="dc-timeline-index" aria-hidden="true">
                  {String(index + 1)}
                </span>
                <span className="dc-timeline-description">{entry.description}</span>
                <span className="dc-timeline-actor">{entry.actorType}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
