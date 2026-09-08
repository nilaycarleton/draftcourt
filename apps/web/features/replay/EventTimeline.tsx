"use client";

import { ReplayTimeline as UiReplayTimeline } from "@draftcourt/ui";

/**
 * Feature wrapper around the UI ReplayTimeline (Phase 3E2 M3).
 *
 * Isolated — receives safe timeline entries from the parent. No fetching.
 */

export interface TimelineEntry {
  sequence: number;
  description: string;
  actorType: string;
  eventType: string;
}

interface EventTimelineProps {
  entries: TimelineEntry[];
  position: number;
  onSelect: (index: number) => void;
}

export function EventTimeline({
  entries,
  position,
  onSelect,
}: EventTimelineProps): React.JSX.Element {
  return <UiReplayTimeline entries={entries} position={position} onSelect={onSelect} />;
}
