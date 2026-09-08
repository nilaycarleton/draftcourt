import type { Meta, StoryObj } from "@storybook/react-vite";
import { Avatar } from "../components/Avatar";

const meta: Meta<typeof Avatar> = {
  title: "DraftCourt/Avatar",
  component: Avatar,
  parameters: { layout: "padded" },
  args: { name: "LeBron James" },
};

export default meta;
type Story = StoryObj<typeof Avatar>;

export const Default: Story = {};

export const Decorative: Story = {
  args: { name: "LeBron James", decorative: true },
};

export const LongInitials: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "var(--dc-space-3)", alignItems: "center" }}>
      <Avatar name="Karl-Anthony Towns" />
      <Avatar name="Shai Gilgeous-Alexander" size="lg" />
      <Avatar name="Jayson Tatum" size="sm" />
    </div>
  ),
};

function ThemedWrap({ theme, children }: { theme: "light" | "dark"; children: React.ReactNode }) {
  return (
    <div
      data-theme={theme}
      style={{
        background: "var(--dc-color-canvas)",
        color: "var(--dc-color-text-primary)",
        padding: "var(--dc-space-4)",
        borderRadius: "var(--dc-radius-lg)",
        border: "1px solid var(--dc-color-border)",
      }}
    >
      <div style={{ display: "flex", gap: "var(--dc-space-3)", alignItems: "center" }}>
        {children}
      </div>
    </div>
  );
}

export const LightTheme: Story = {
  render: () => (
    <ThemedWrap theme="light">
      <Avatar name="LeBron James" colorPrimary="#552583" colorSecondary="#FDB927" />
      <Avatar name="Jaylen Brown" colorPrimary="#007A33" colorSecondary="#BA9653" decorative />
    </ThemedWrap>
  ),
};

export const DarkTheme: Story = {
  render: () => (
    <ThemedWrap theme="dark">
      <Avatar name="LeBron James" colorPrimary="#552583" colorSecondary="#FDB927" />
      <Avatar name="Jaylen Brown" colorPrimary="#007A33" colorSecondary="#BA9653" decorative />
    </ThemedWrap>
  ),
};
