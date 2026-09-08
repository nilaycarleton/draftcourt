import type { Meta, StoryObj } from "@storybook/react-vite";
import { StrengthWeaknessCards } from "../components/StrengthWeaknessCards";

const meta: Meta<typeof StrengthWeaknessCards> = {
  title: "DraftCourt/StrengthWeaknessCards",
  component: StrengthWeaknessCards,
  parameters: { layout: "padded" },
};

export default meta;
type Story = StoryObj<typeof StrengthWeaknessCards>;

export const Strengths: Story = {
  render: () => (
    <div style={{ maxWidth: 720 }}>
      <StrengthWeaknessCards
        positionItems={[
          {
            key: "PG",
            label: "Point Guard",
            value: 0.82,
            tone: "strength",
            reason: "Two top-30 PGs vs replacement.",
          },
        ]}
        categoryItems={[{ key: "PTS", label: "Points", value: 0.78, tone: "strength" }]}
      />
    </div>
  ),
};

export const Weaknesses: Story = {
  render: () => (
    <div style={{ maxWidth: 720 }}>
      <StrengthWeaknessCards
        positionItems={[
          {
            key: "C",
            label: "Center",
            value: 0.31,
            tone: "weakness",
            reason: "Thin after round 8; bench center is rank 45.",
          },
        ]}
        categoryItems={[
          {
            key: "REB",
            label: "Rebounds",
            value: 0.34,
            tone: "weakness",
            reason: "Benched big in punt-leak check.",
          },
        ]}
      />
    </div>
  ),
};

export const Empty: Story = {
  render: () => (
    <div style={{ maxWidth: 720 }}>
      <StrengthWeaknessCards positionItems={[]} categoryItems={[]} />
    </div>
  ),
};
