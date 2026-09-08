import type { Meta, StoryObj } from "@storybook/react-vite";
import { GradeBreakdown } from "../components/GradeBreakdown";

const meta: Meta<typeof GradeBreakdown> = {
  title: "DraftCourt/GradeBreakdown",
  component: GradeBreakdown,
  parameters: { layout: "padded" },
};

export default meta;
type Story = StoryObj<typeof GradeBreakdown>;

const representativeComponents = [
  { key: "valueCaptured", value: 0.82, reason: "Mean ADP value above replacement vs pool." },
  {
    key: "projectedStrength",
    value: 0.76,
    reason: "Season fantasy points / category win probability.",
  },
  { key: "rosterBalance", value: 0.68, reason: "Gini of position counts and bench waste." },
  { key: "risk", value: 0.71, reason: "Safety from injury risk and interval width." },
  { key: "scoringFit", value: 0.84, reason: "Punt leakage and category emphasis fit." },
];

export const Default: Story = {
  render: () => (
    <div style={{ maxWidth: 560 }}>
      <GradeBreakdown components={representativeComponents} />
    </div>
  ),
};

export const Empty: Story = {
  render: () => (
    <div style={{ maxWidth: 560 }}>
      <GradeBreakdown components={[]} />
    </div>
  ),
};
