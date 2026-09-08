"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  replayToSequence,
  ReplayError,
  actorOf,
  describeReplayEvent,
  type ReplayInputEvent,
} from "@draftcourt/domain";
import { ReplayControls, type ReplaySpeed } from "./ReplayControls";
import { EventTimeline } from "./EventTimeline";

/**
 * Owner-only draft replay (Phase 3E2 M3, ADR 0016 R1–R3).
 *
 * Derived entirely from the immutable event log fetched once from the
 * owner-only events endpoint. Moving backward/forward never mutates the
 * draft — every position is a pure `replayToSequence` reduction. The page
 * loads at the final state; reload returns to the final state (documented).
 *
 * Corrupt histories fail closed: a typed `ReplayError` renders an actionable
 * error and the integrity badge reads FAIL — replay is never presented as
 * trustworthy when verification fails.
 */

interface RawEvent {
  id: string;
  sequence: number;
  eventType: string;
  teamSlot: number | null;
  playerId: string | null;
  round: number | null;
  pickInRound: number | null;
  causationEventId: string | null;
  payload: unknown;
  createdAt?: string;
}

interface ReadModelAssignment {
  playerId: string;
  playerName: string;
}

const STEP_MS: Record<ReplaySpeed, number> = { 1: 800, 2: 400 };

function toReplayInput(event: RawEvent): ReplayInputEvent {
  const payload = event.payload as {
    slotPosition?: unknown;
    isBench?: unknown;
    keeper?: unknown;
  } | null;
  return {
    sequence: event.sequence,
    eventType: event.eventType,
    eventId: event.id,
    causationEventId: event.causationEventId,
    teamSlot: event.teamSlot,
    playerId: event.playerId,
    slotPosition:
      payload !== null && typeof payload === "object" && typeof payload.slotPosition === "string"
        ? payload.slotPosition
        : null,
    isBench: payload !== null && typeof payload === "object" && payload.isBench === true,
    isKeeper: payload !== null && typeof payload === "object" && payload.keeper === true,
    payload: event.payload,
  };
}

export function ReplaySection({ draftId }: { draftId: string }): React.JSX.Element {
  const [rawEvents, setRawEvents] = useState<RawEvent[] | null>(null);
  const [teamCount, setTeamCount] = useState<number>(12);
  const [playerNames, setPlayerNames] = useState<Map<string, string>>(new Map());
  const [expectedFinalCount, setExpectedFinalCount] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [position, setPosition] = useState<number>(-1);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<ReplaySpeed>(1);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Initial load: immutable event log + read model (names + final count).
  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const [eventsResponse, draftResponse] = await Promise.all([
          fetch(`/api/v1/drafts/${draftId}/events`, { cache: "no-store" }),
          fetch(`/api/v1/drafts/${draftId}`, { cache: "no-store" }),
        ]);
        if (!eventsResponse.ok)
          throw new Error(`events request failed (${String(eventsResponse.status)})`);
        const eventsBody = (await eventsResponse.json()) as { data?: RawEvent[] };
        const ordered = [...(eventsBody.data ?? [])].sort((a, b) => a.sequence - b.sequence);
        let count = 12;
        const names = new Map<string, string>();
        let finalCount: number | null = null;
        if (draftResponse.ok) {
          const draftBody = (await draftResponse.json()) as {
            data?: {
              settingsSnapshot?: { teamCount?: number };
              teams?: { assignments?: ReadModelAssignment[] }[];
            };
          };
          if (typeof draftBody.data?.settingsSnapshot?.teamCount === "number") {
            count = draftBody.data.settingsSnapshot.teamCount;
          }
          const teams = draftBody.data?.teams ?? [];
          finalCount = teams.reduce((sum, team) => sum + (team.assignments?.length ?? 0), 0);
          for (const team of teams) {
            for (const assignment of team.assignments ?? []) {
              names.set(assignment.playerId, assignment.playerName);
            }
          }
        }
        if (cancelled) return;
        setRawEvents(ordered);
        setTeamCount(count);
        setPlayerNames(names);
        setExpectedFinalCount(finalCount);
        setPosition(ordered.length === 0 ? -1 : ordered.length - 1);
      } catch (error) {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : "Failed to load draft events.");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [draftId]);

  const inputs = useMemo(() => (rawEvents ?? []).map(toReplayInput), [rawEvents]);

  const replayError = useMemo(() => {
    if (inputs.length === 0) return null;
    try {
      replayToSequence(inputs, teamCount, inputs[inputs.length - 1]?.sequence ?? 0);
      return null;
    } catch (error) {
      return error instanceof ReplayError
        ? error
        : new ReplayError("MALFORMED_EVENT", "Replay failed.");
    }
  }, [inputs, teamCount]);

  const stateAtPosition = useMemo(() => {
    if (inputs.length === 0 || position < 0) return null;
    const upto = inputs[position]?.sequence ?? 0;
    try {
      return replayToSequence(inputs, teamCount, upto);
    } catch {
      return null;
    }
  }, [inputs, position, teamCount]);

  const finalReplayCount = useMemo(() => {
    if (inputs.length === 0) return 0;
    try {
      return replayToSequence(inputs, teamCount, inputs[inputs.length - 1]?.sequence ?? 0)
        .selections.length;
    } catch {
      return -1;
    }
  }, [inputs, teamCount]);

  const integrityOk =
    replayError === null &&
    (expectedFinalCount === null || finalReplayCount === expectedFinalCount);
  const integrityDetail = !integrityOk
    ? (replayError?.message ?? "Replay diverges from the authoritative roster view.")
    : `${String(finalReplayCount)} effective selections`;

  // Playback: fixed-interval stepping (fake-time friendly: each tick advances
  // exactly one event). Speed changes derived state timing only, never state.
  // The end-of-log stop happens inside the tick callback (never a synchronous
  // setState in the effect body); reaching the end pauses with position held.
  useEffect(() => {
    if (!playing) return undefined;
    if (position >= inputs.length - 1) {
      const stop = window.setTimeout(() => {
        setPlaying(false);
      }, 0);
      return () => {
        window.clearTimeout(stop);
      };
    }
    timer.current = setInterval(() => {
      setPosition((current) => Math.min(current + 1, inputs.length - 1));
    }, STEP_MS[speed]);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [playing, position, speed, inputs.length]);

  const goFirst = useCallback(() => {
    setPlaying(false);
    setPosition(inputs.length === 0 ? -1 : 0);
  }, [inputs.length]);
  const goPrevious = useCallback(() => {
    setPlaying(false);
    setPosition((current) => Math.max(0, current - 1));
  }, []);
  const goNext = useCallback(() => {
    setPlaying(false);
    setPosition((current) => Math.min(inputs.length - 1, current + 1));
  }, [inputs.length]);
  const goLast = useCallback(() => {
    setPlaying(false);
    setPosition(inputs.length === 0 ? -1 : inputs.length - 1);
  }, [inputs.length]);
  const togglePlay = useCallback(() => {
    if (inputs.length === 0) return;
    // Restart from the first event when pressing play at the final event.
    if (!playing && position >= inputs.length - 1) {
      setPosition(0);
      setPlaying(true);
    } else setPlaying((value) => !value);
  }, [inputs.length, playing, position]);

  // Page-level shortcuts (same model as the draft room): ignored while typing
  // or activating native buttons with Space (native click covers those).
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

  const timelineEntries = useMemo(() => {
    const overallByIndex = overallPickByIndex(inputs);
    return inputs.map((input, index) => ({
      sequence: input.sequence,
      eventType: input.eventType,
      actorType: actorOf({ eventType: input.eventType, payload: input.payload }),
      description:
        input.eventType === "PLAYER_DRAFTED" && input.playerId !== null
          ? `${describeReplayEvent(input, teamCount, overallByIndex[index] ?? undefined)} — ${playerNames.get(input.playerId) ?? "Unknown player"}`
          : describeReplayEvent(input, teamCount, undefined),
    }));
  }, [inputs, playerNames, teamCount]);

  const currentEntry = position >= 0 ? (timelineEntries[position] ?? null) : null;
  const picks = useMemo(() => stateAtPosition?.selections ?? [], [stateAtPosition]);
  const rosters = useMemo(() => {
    const byTeam = new Map<number, typeof picks>();
    for (const pick of picks) {
      const list = byTeam.get(pick.teamSlot) ?? [];
      list.push(pick);
      byTeam.set(pick.teamSlot, list);
    }
    return [...byTeam.entries()].sort((a, b) => a[0] - b[0]);
  }, [picks]);

  if (loadError !== null) {
    return (
      <section aria-labelledby="replay-heading" className="dc-replay-section">
        <h2 id="replay-heading">Draft replay</h2>
        <div role="alert" className="dc-replay-error">
          <p>Could not load the event history: {loadError}</p>
          <p>Reload the page to retry. Picks, undo, and analysis are unaffected.</p>
        </div>
      </section>
    );
  }

  if (rawEvents === null) {
    return (
      <section aria-labelledby="replay-heading" className="dc-replay-section">
        <h2 id="replay-heading">Draft replay</h2>
        <p role="status">Loading event history…</p>
      </section>
    );
  }

  if (replayError !== null || stateAtPosition === null) {
    return (
      <section aria-labelledby="replay-heading" className="dc-replay-section">
        <h2 id="replay-heading">Draft replay</h2>
        <p role="status" className={`dc-integrity-badge dc-integrity-fail`}>
          <span aria-hidden="true">✕</span> Replay integrity: FAIL
        </p>
        <div role="alert" className="dc-replay-error">
          <p>This draft&apos;s event history could not be replayed safely.</p>
          <p>{replayError?.message ?? "The history is incomplete or corrupted."}</p>
          <p>
            The final results above remain the authoritative record. Ask an admin to inspect the
            draft event log before trusting a step-by-step replay.
          </p>
        </div>
      </section>
    );
  }

  const lastPick = picks[picks.length - 1] ?? null;

  return (
    <section aria-labelledby="replay-heading" className="dc-replay-section">
      <h2 id="replay-heading">Draft replay</h2>
      <p className="dc-hint">
        Step through the immutable event history. Replay never changes the draft — reloading returns
        to the final state.
      </p>
      <p
        role="status"
        className={`dc-integrity-badge ${integrityOk ? "dc-integrity-ok" : "dc-integrity-fail"}`}
      >
        <span aria-hidden="true">{integrityOk ? "✓" : "✕"}</span> Replay integrity:{" "}
        {integrityOk ? "OK" : "FAIL"} — {integrityDetail}
      </p>
      {/* Concise live announcements: stepping announces; continuous playback
          does not flood assistive technology (progress shown in plain text). */}
      <p aria-live="polite" className="dc-visually-hidden">
        {!playing && currentEntry !== null
          ? `Event ${String(position + 1)} of ${String(inputs.length)}: ${currentEntry.description}`
          : ""}
      </p>
      <p aria-live="off" className="dc-hint">
        {playing
          ? `Playing${speed === 2 ? " at 2×" : ""}… event ${String(position + 1)} of ${String(inputs.length)}`
          : currentEntry !== null
            ? `Showing event ${String(position + 1)} of ${String(inputs.length)}: ${currentEntry.description}`
            : "No events to show."}
      </p>
      {lastPick !== null && (
        <p className="dc-hint">
          Round {String(lastPick.round)} · Pick {String(lastPick.pickInRound)} · Team{" "}
          {String(lastPick.teamSlot)} · {picks.length} selection{picks.length === 1 ? "" : "s"} ·
          next overall pick {String(stateAtPosition.nextOverallPick)}
        </p>
      )}
      <ReplayControls
        position={Math.max(position, 0)}
        total={inputs.length}
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
          setPosition(Math.max(0, Math.min(index, inputs.length - 1)));
        }}
      />
      <p className="dc-hint">
        Keyboard: Space plays or pauses · ← previous · → next · Home first · End last.
      </p>
      <div className="dc-replay-panels">
        <div className="dc-replay-board-panel">
          <h3>Board at this event</h3>
          {picks.length === 0 ? (
            <p className="dc-hint">No picks yet at this point in the draft.</p>
          ) : (
            <div
              className="dc-table-scroll"
              role="region"
              aria-label="Drafted players in pick order at the current replay position, scrollable"
              tabIndex={0}
            >
              <table className="dc-replay-table">
                <caption className="dc-visually-hidden">
                  Drafted players in pick order at the current replay position
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Pick</th>
                    <th scope="col">Round</th>
                    <th scope="col">Team</th>
                    <th scope="col">Player</th>
                    <th scope="col">Slot</th>
                  </tr>
                </thead>
                <tbody>
                  {picks.map((pick) => (
                    <tr key={pick.eventId}>
                      <td>{pick.overallPick}</td>
                      <td>{pick.round}</td>
                      <td>{pick.teamSlot}</td>
                      <td>{playerNames.get(pick.playerId) ?? "Unknown player"}</td>
                      <td>
                        {pick.slotPosition}
                        {pick.isKeeper ? " (keeper)" : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="dc-replay-roster-panel">
          <h3>Rosters at this event</h3>
          {rosters.length === 0 ? (
            <p className="dc-hint">No roster assignments yet.</p>
          ) : (
            <ul className="dc-replay-rosters">
              {rosters.map(([slot, roster]) => (
                <li key={slot}>
                  <strong>Team {slot}</strong>
                  <ul>
                    {roster.map((pick) => (
                      <li key={pick.eventId}>
                        {playerNames.get(pick.playerId) ?? "Unknown player"} · {pick.slotPosition}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <h3>Event timeline</h3>
      <EventTimeline
        entries={timelineEntries}
        position={Math.max(position, 0)}
        onSelect={(index) => {
          setPlaying(false);
          setPosition(index);
        }}
      />
    </section>
  );
}

/** Overall-pick number each pick event received during one sequential sweep
 * (mirrors the reducer cursor: keepers included, undone picks free their
 * number for alternate histories). Non-pick entries map to null. */
function overallPickByIndex(inputs: ReplayInputEvent[]): (number | null)[] {
  const result: (number | null)[] = Array.from({ length: inputs.length }, () => null);
  const activeByEventId = new Map<string, string>();
  const activeByPlayer = new Map<string, string>();
  let next = 1;
  inputs.forEach((input, index) => {
    if (input.eventType === "PLAYER_DRAFTED" && input.playerId !== null) {
      if (!activeByPlayer.has(input.playerId)) {
        result[index] = next;
        activeByEventId.set(input.eventId, input.playerId);
        activeByPlayer.set(input.playerId, input.eventId);
        next += 1;
      }
    } else if (input.eventType === "PICK_UNDONE" && input.causationEventId !== null) {
      const playerId = activeByEventId.get(input.causationEventId);
      if (playerId !== undefined && activeByPlayer.get(playerId) === input.causationEventId) {
        activeByEventId.delete(input.causationEventId);
        activeByPlayer.delete(playerId);
        next = Math.max(1, next - 1);
      }
    }
  });
  return result;
}
