import type { Meta, StoryObj } from "@storybook/react-vite";
import { Badge } from "../components/Badge";
import { Card } from "../components/Card";

const meta: Meta<typeof Card> = {
  title: "DraftCourt/Card",
  component: Card,
};

export default meta;
type Story = StoryObj<typeof Card>;

export const Default: Story = {
  render: () => (
    <Card>
      <p style={{ margin: 0, fontWeight: 600 }}>Placeholder Player</p>
      <p style={{ margin: "0.25rem 0 0", color: "var(--dc-color-text-secondary)" }}>
        PG · Placeholder Team
      </p>
      <div style={{ marginTop: "0.75rem" }}>
        <Badge variant="success">Best Fit</Badge>
      </div>
    </Card>
  ),
};
