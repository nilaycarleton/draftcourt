import type { Meta, StoryObj } from "@storybook/react-vite";
import { RoundValueTable, type RoundValueRow } from "../components/RoundValueTable";

const meta: Meta<typeof RoundValueTable> = {
  title: "DraftCourt/RoundValueTable",
  component: RoundValueTable,
  parameters: { layout: "padded" },
};

export default meta;
type Story = StoryObj<typeof RoundValueTable>;

const populatedRows: RoundValueRow[] = [
  {
    round: 1,
    pickInRound: 4,
    overallPick: 4,
    playerName: "Nikola Jokic",
    playerId: "p1",
    valueAboveReplacement: 18.4,
    adpDelta: -8,
    isBestValue: true,
  },
  {
    round: 2,
    pickInRound: 9,
    overallPick: 21,
    playerName: "Shai Gilgeous-Alexander",
    playerId: "p2",
    valueAboveReplacement: 6.2,
    adpDelta: 2,
  },
  {
    round: 3,
    pickInRound: 4,
    overallPick: 28,
    playerName: "Victor Wembanyama",
    playerId: "p3",
    valueAboveReplacement: 12.1,
    adpDelta: -12,
  },
  {
    round: 4,
    pickInRound: 9,
    overallPick: 45,
    playerName: "Anthony Edwards",
    playerId: "p4",
    valueAboveReplacement: -2.3,
    adpDelta: 14,
    isBiggestReach: true,
  },
];

export const Populated: Story = {
  render: () => (
    <div style={{ maxWidth: 720 }}>
      <RoundValueTable rows={populatedRows} />
    </div>
  ),
};

export const Empty: Story = {
  render: () => (
    <div style={{ maxWidth: 720 }}>
      <RoundValueTable rows={[]} />
    </div>
  ),
};
