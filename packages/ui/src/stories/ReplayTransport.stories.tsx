import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ReplayTransport, ReplayTimeline } from "../components/ReplayTransport";

const meta: Meta<typeof ReplayTransport> = {
  title: "DraftCourt/ReplayTransport",
  component: ReplayTransport,
};

export default meta;
type Story = StoryObj<typeof ReplayTransport>;

function InteractiveTransport(args: { total?: number; start?: number }) {
  const total = args.total ?? 9;
  const [position, setPosition] = useState(args.start ?? total - 1);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<1 | 2>(1);
  return (
    <ReplayTransport
      position={position}
      total={total}
      playing={playing}
      speed={speed}
      onFirst={() => {
        setPosition(0);
      }}
      onPrevious={() => {
        setPosition((p) => Math.max(0, p - 1));
      }}
      onTogglePlay={() => {
        setPlaying((v) => !v);
      }}
      onNext={() => {
        setPosition((p) => Math.min(total - 1, p + 1));
      }}
      onLast={() => {
        setPosition(total - 1);
      }}
      onSpeedChange={setSpeed}
      onScrub={setPosition}
    />
  );
}

export const FinalState: Story = {
  render: () => <InteractiveTransport total={9} />,
};

export const MidDraft: Story = {
  render: () => <InteractiveTransport total={170} start={42} />,
};

function Playing2xTransport() {
  const [position, setPosition] = useState(3);
  return (
    <ReplayTransport
      position={position}
      total={12}
      playing
      speed={2}
      onFirst={() => {
        setPosition(0);
      }}
      onPrevious={() => {
        setPosition((p) => Math.max(0, p - 1));
      }}
      onTogglePlay={() => undefined}
      onNext={() => {
        setPosition((p) => Math.min(11, p + 1));
      }}
      onLast={() => {
        setPosition(11);
      }}
      onSpeedChange={() => undefined}
      onScrub={setPosition}
    />
  );
}

export const Playing2x: Story = {
  render: () => <Playing2xTransport />,
};

export const Empty: Story = {
  render: () => (
    <ReplayTransport
      position={0}
      total={0}
      playing={false}
      speed={1}
      onFirst={() => undefined}
      onPrevious={() => undefined}
      onTogglePlay={() => undefined}
      onNext={() => undefined}
      onLast={() => undefined}
      onSpeedChange={() => undefined}
      onScrub={() => undefined}
    />
  ),
};

const timelineEntries = [
  {
    sequence: 1,
    description: "Draft started (seq 1)",
    actorType: "SYSTEM",
    eventType: "DRAFT_STARTED",
  },
  {
    sequence: 2,
    description:
      "Pick 1 (R1P1) · Team 1 · UTIL (seq 2) — Player With An Extremely Long Display Name That Must Wrap",
    actorType: "USER",
    eventType: "PLAYER_DRAFTED",
  },
  {
    sequence: 3,
    description: "Pick 2 (R1P2) · Team 2 · UTIL · CPU (seq 3) — Another Long Name",
    actorType: "CPU",
    eventType: "PLAYER_DRAFTED",
  },
  {
    sequence: 4,
    description: "Draft paused (seq 4)",
    actorType: "SYSTEM",
    eventType: "DRAFT_PAUSED",
  },
  {
    sequence: 5,
    description: "Draft resumed (seq 5)",
    actorType: "SYSTEM",
    eventType: "DRAFT_RESUMED",
  },
  {
    sequence: 6,
    description: "Pick undone (Team 2) (seq 6)",
    actorType: "USER",
    eventType: "PICK_UNDONE",
  },
];

function InteractiveTimeline() {
  const [position, setPosition] = useState(2);
  return <ReplayTimeline entries={timelineEntries} position={position} onSelect={setPosition} />;
}

export const Timeline: StoryObj = {
  render: () => <InteractiveTimeline />,
};
