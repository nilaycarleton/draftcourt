import type { Meta, StoryObj } from "@storybook/react-vite";
import { Badge } from "../components/Badge";

const meta: Meta<typeof Badge> = {
  title: "DraftCourt/Badge",
  component: Badge,
  args: { children: "Best Overall" },
  argTypes: {
    variant: {
      control: "select",
      options: ["neutral", "info", "success", "warning", "danger"],
    },
  },
};

export default meta;
type Story = StoryObj<typeof Badge>;

export const AllVariants: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
      <Badge variant="neutral">Neutral</Badge>
      <Badge variant="info">Best Value</Badge>
      <Badge variant="success">Best Overall</Badge>
      <Badge variant="warning">Above ADP</Badge>
      <Badge variant="danger">High Risk</Badge>
    </div>
  ),
};
