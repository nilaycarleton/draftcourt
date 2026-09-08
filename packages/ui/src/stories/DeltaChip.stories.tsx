import type { Meta, StoryObj } from "@storybook/react-vite";
import { DeltaChip } from "../components/DeltaChip";

const meta: Meta<typeof DeltaChip> = {
  title: "DraftCourt/DeltaChip",
  component: DeltaChip,
  parameters: { layout: "padded" },
};

export default meta;
type Story = StoryObj<typeof DeltaChip>;

export const StrongValue: Story = {
  args: { delta: -14 },
};

export const Value: Story = {
  args: { delta: -4 },
};

export const Neutral: Story = {
  args: { delta: 0 },
};

export const AtMarket: Story = {
  args: { delta: 5 },
};

export const Reach: Story = {
  args: { delta: 14 },
};

export const AllStates: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "var(--dc-space-3)", flexWrap: "wrap" }}>
      <DeltaChip delta={-14} />
      <DeltaChip delta={-4} />
      <DeltaChip delta={0} />
      <DeltaChip delta={5} />
      <DeltaChip delta={14} />
    </div>
  ),
};
