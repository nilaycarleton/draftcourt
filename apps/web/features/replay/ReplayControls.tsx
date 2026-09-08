"use client";

import { ReplayTransport, type ReplayTransportSpeed } from "@draftcourt/ui";

/**
 * Feature wrapper around the UI ReplayTransport (Phase 3E2 M3).
 *
 * Keeps the feature-level `ReplayControls` / `ReplaySpeed` names used by
 * `ReplaySection` and `SharedReplay`; the presentational contract (markup,
 * accessible names, disabled states) lives in `@draftcourt/ui` with
 * Storybook coverage.
 */

export type ReplaySpeed = ReplayTransportSpeed;

export interface ReplayControlsProps {
  position: number;
  total: number;
  playing: boolean;
  speed: ReplaySpeed;
  disabled?: boolean;
  onFirst: () => void;
  onPrevious: () => void;
  onTogglePlay: () => void;
  onNext: () => void;
  onLast: () => void;
  onSpeedChange: (speed: ReplaySpeed) => void;
  onScrub: (sequence: number) => void;
}

export function ReplayControls(props: ReplayControlsProps): React.JSX.Element {
  return <ReplayTransport {...props} />;
}
