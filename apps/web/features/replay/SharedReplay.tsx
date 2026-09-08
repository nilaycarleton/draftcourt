"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReplayControls, type ReplaySpeed } from "./ReplayControls";
import { EventTimeline } from "./EventTimeline";
import type { SharedTimelineEntry } from "@/lib/server/share";

/**
 * Read-only replay for the public shared-result view (ADR 0016 R6).
 *
 * Consumes the redacted DTO only — never owner event objects, player ids, or
 * internal causation ids. Undone picks hide via `undoneAtSequence`
 * (sequence arithmetic, no internal ids). No fetching, no mutations.
 */

const STEP_MS: Record<ReplaySpeed, number> = { 1: 800, 2: 400 };

export interface SharedBoardPick {
  overallPick: number;
  round: number;
  pickInRound: number;
  teamSlot: number;
  teamName: string;
  playerName: string;
  slotPosition: string | null;
  isKeeper: boolean;
}

interface SharedReplayProps {
  timeline: SharedTimelineEntry[];
  board: SharedBoardPick[];
  integrityOk: boolean;
  integrityDetail: string;
}

export function SharedReplay({
  timeline,
  board,
  integrityOk,
  integrityDetail,
}: SharedReplayProps): React.JSX.Element {
  const [position, setPosition] = useState(() =>
    timeline.length === 0 ? -1 : timeline.length - 1,
  );
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<ReplaySpeed>(1);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!playing) return undefined;
    if (position >= timeline.length - 1) {
      const stop = window.setTimeout(() => {
        setPlaying(false);
      }, 0);
      return () => {
        window.clearTimeout(stop);
      };
    }
    timer.current = setInterval(() => {
      setPosition((current) => Math.min(current + 1, timeline.length - 1));
    }, STEP_MS[speed]);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [playing, position, speed, timeline.length]);

  const goFirst = useCallback(() => {
    setPlaying(false);
    setPosition(timeline.length === 0 ? -1 : 0);
  }, [timeline.length]);
  const goPrevious = useCallback(() => {
    setPlaying(false);
    setPosition((current) => Math.max(0, current - 1));
  }, []);
  const goNext = useCallback(() => {
    setPlaying(false);
    setPosition((current) => Math.min(timeline.length - 1, current + 1));
  }, [timeline.length]);
  const goLast = useCallback(() => {
    setPlaying(false);
    setPosition(timeline.length === 0 ? -1 : timeline.length - 1);
  }, [timeline.length]);
  const togglePlay = useCallback(() => {
    if (timeline.length === 0) return;
    if (!playing && position >= timeline.length - 1) {
      setPosition(0);
      setPlaying(true);
    } else setPlaying((value) => !value);
  }, [playing, position, timeline.length]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target !== null) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable)
          return;
        // Native button activation already toggles/steps: a global Space
        // handler would fire twice (keydown + click). Arrows/Home/End have
        // no native button behavior and stay global for discoverability.
        if (tag === "BUTTON" && event.key === " ") return;
      }
      switch (event.key) {
        case " ":
          event.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          event.preventDefault();
          goPrevious();
          break;
        case "ArrowRight":
          event.preventDefault();
          goNext();
          break;
        case "Home":
          event.preventDefault();
          goFirst();
          break;
        case "End":
          event.preventDefault();
          goLast();
          break;
        default:
          break;
      }
    },
    [goFirst, goLast, goNext, goPrevious, togglePlay],
  );

  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onKeyDown]);

  const cutoff = position >= 0 ? (timeline[position]?.sequence ?? 0) : 0;
  const visiblePicks = useMemo(() => {
    const undoneAtBySequence = new Map<number, number>();
    for (const entry of timeline) {
      if (entry.undoneAtSequence !== null)
        undoneAtBySequence.set(entry.sequence, entry.undoneAtSequence);
    }
    return board.filter((pick) => {
      // Alternate histories reuse overall numbers after undo: the effective
      // pick is the LAST matching event at or before the cutoff.
      let pickEntry: SharedTimelineEntry | null = null;
      for (const entry of timeline) {
        if (
          entry.eventType === "PLAYER_DRAFTED" &&
          entry.overallPick === pick.overallPick &&
          entry.teamSlot === pick.teamSlot &&
          entry.sequence <= cutoff
        ) {
          pickEntry = entry;
        }
      }
      if (!pickEntry) return false;
      const undoneAt = undoneAtBySequence.get(pickEntry.sequence);
      return undoneAt === undefined || undoneAt > cutoff;
    });
  }, [board, cutoff, timeline]);

  const currentEntry = position >= 0 ? (timeline[position] ?? null) : null;

  if (timeline.length === 0) {
    return (
      <section aria-labelledby="shared-replay-heading" className="dc-replay-section">
        <h2 id="shared-replay-heading">Draft replay</h2>
        <p className="dc-hint">No event history is available for this shared result.</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="shared-replay-heading" className="dc-replay-section">
      <h2 id="shared-replay-heading">Draft replay</h2>
      <p
        role="status"
        className={`dc-integrity-badge ${integrityOk ? "dc-integrity-ok" : "dc-integrity-fail"}`}
      >
        <span aria-hidden="true">{integrityOk ? "✓" : "✕"}</span> Replay integrity:{" "}
        {integrityOk ? "OK" : "FAIL"} — {integrityDetail}
      </p>
      {!integrityOk && (
        <div role="alert" className="dc-replay-error">
          <p>
            This shared history could not be verified. The final board below remains shown for
            context.
          </p>
        </div>
      )}
      <p aria-live="polite" className="dc-visually-hidden">
        {!playing && currentEntry !== null
          ? `Event ${String(position + 1)} of ${String(timeline.length)}: ${currentEntry.description}`
          : ""}
      </p>
      <p aria-live="off" className="dc-hint">
        {playing
          ? `Playing${speed === 2 ? " at 2×" : ""}… event ${String(position + 1)} of ${String(timeline.length)}`
          : currentEntry !== null
            ? `Showing event ${String(position + 1)} of ${String(timeline.length)}: ${currentEntry.description}`
            : "No events to show."}
      </p>
      <ReplayControls
        position={Math.max(position, 0)}
        total={timeline.length}
        playing={playing}
        speed={speed}
        onFirst={goFirst}
        onPrevious={goPrevious}
        onTogglePlay={togglePlay}
        onNext={goNext}
        onLast={goLast}
        onSpeedChange={setSpeed}
        onScrub={(index) => {
          setPlaying(false);
          setPosition(Math.max(0, Math.min(index, timeline.length - 1)));
        }}
      />
      <p className="dc-hint">
        Keyboard: Space plays or pauses · ← previous · → next · Home first · End last.
      </p>
      <h3>Board at this event</h3>
      {visiblePicks.length === 0 ? (
        <p className="dc-hint">No picks yet at this point in the draft.</p>
      ) : (
        <div
          className="dc-table-scroll"
          role="region"
          aria-label="Shared draft picks in order at the current replay position, scrollable"
          tabIndex={0}
        >
          <table className="dc-replay-table">
            <caption className="dc-visually-hidden">
              Shared draft picks in order at the current replay position
            </caption>
            <thead>
              <tr>
                <th scope="col">Pick</th>
                <th scope="col">Round</th>
                <th scope="col">Team</th>
                <th scope="col">Player</th>
              </tr>
            </thead>
            <tbody>
              {visiblePicks.map((pick) => (
                <tr key={`${String(pick.overallPick)}-${String(pick.teamSlot)}`}>
                  <td>{pick.overallPick}</td>
                  <td>{pick.round}</td>
                  <td>{pick.teamName}</td>
                  <td>{pick.playerName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3>Event timeline</h3>
      <EventTimeline
        entries={timeline.map((entry) => ({
          sequence: entry.sequence,
          description: entry.description,
          actorType: entry.actorType,
          eventType: entry.eventType,
        }))}
        position={Math.max(position, 0)}
        onSelect={(index) => {
          setPlaying(false);
          setPosition(index);
        }}
      />
    </section>
  );
}
