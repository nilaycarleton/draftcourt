import type { Meta, StoryObj } from "@storybook/react-vite";
import { StandingDistribution } from "../components/StandingDistribution";

const meta: Meta<typeof StandingDistribution> = {
  title: "DraftCourt/StandingDistribution",
  component: StandingDistribution,
  parameters: { layout: "padded" },
};

export default meta;
type Story = StoryObj<typeof StandingDistribution>;

const samplePoints = [
  { standing: 1, probability: 0.08 },
  { standing: 2, probability: 0.14 },
  { standing: 3, probability: 0.21 },
  { standing: 4, probability: 0.18 },
  { standing: 5, probability: 0.12 },
  { standing: 6, probability: 0.09 },
  { standing: 7, probability: 0.06 },
  { standing: 8, probability: 0.04 },
  { standing: 9, probability: 0.03 },
  { standing: 10, probability: 0.02 },
  { standing: 11, probability: 0.02 },
  { standing: 12, probability: 0.01 },
];

export const Default: Story = {
  render: () => (
    <div style={{ maxWidth: 640 }}>
      <StandingDistribution points={samplePoints} p50={4} p90={8} simulationCount={2000} />
      <p
        style={{
          fontSize: "var(--dc-font-size-xs)",
          color: "var(--dc-color-text-muted)",
          margin: "8px 0 0",
        }}
      >
        The data table below the chart is the accessible alternative — it stays visible at all
        times.
      </p>
    </div>
  ),
};

export const Empty: Story = {
  render: () => (
    <div style={{ maxWidth: 640 }}>
      <StandingDistribution points={[]} />
    </div>
  ),
};
