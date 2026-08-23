import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "../components/Button";

const meta: Meta<typeof Button> = {
  title: "DraftCourt/Button",
  component: Button,
  args: {
    children: "Draft player",
    variant: "primary",
    size: "md",
  },
  argTypes: {
    variant: { control: "select", options: ["primary", "secondary", "ghost", "danger"] },
    size: { control: "select", options: ["sm", "md", "lg"] },
  },
};

export default meta;
type Story = StoryObj<typeof Button>;

export const Primary: Story = {};

export const Secondary: Story = { args: { variant: "secondary" } };

export const Ghost: Story = { args: { variant: "ghost" } };

export const Danger: Story = { args: { variant: "danger", children: "Undo pick" } };

export const Loading: Story = { args: { loading: true } };

export const Disabled: Story = { args: { disabled: true } };
