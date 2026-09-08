import type { Meta, StoryObj } from "@storybook/react-vite";
import { ScoreBar } from "../components/ScoreBar";

const meta: Meta<typeof ScoreBar> = {
  title: "DraftCourt/ScoreBar",
  component: ScoreBar,
  parameters: { layout: "padded" },
};

export default meta;
type Story = StoryObj<typeof ScoreBar>;

export const ZeroPercent: Story = {
  args: { label: "Consistency", value: 0 },
};

export const MidRange: Story = {
  args: { label: "Upside", value: 0.55 },
};

export const FullPercent: Story = {
  args: { label: "Role security", value: 1 },
};

export const InvertedRisk: Story = {
  render: () => (
    <div style={{ display: "grid", gap: "var(--dc-space-3)", maxWidth: 480 }}>
      <ScoreBar label="Injury risk (low)" value={0.15} invert />
      <ScoreBar label="Injury risk (high)" value={0.85} invert />
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
        display: "grid",
        gap: "var(--dc-space-3)",
        maxWidth: 480,
      }}
    >
      {children}
    </div>
  );
}

export const LightTheme: Story = {
  render: () => (
    <ThemedWrap theme="light">
      <ScoreBar label="Consistency" value={0} />
      <ScoreBar label="Upside" value={0.55} />
      <ScoreBar label="Role security" value={1} />
      <ScoreBar label="Injury risk" value={0.85} invert />
    </ThemedWrap>
  ),
};

export const DarkTheme: Story = {
  render: () => (
    <ThemedWrap theme="dark">
      <ScoreBar label="Consistency" value={0} />
      <ScoreBar label="Upside" value={0.55} />
      <ScoreBar label="Role security" value={1} />
      <ScoreBar label="Injury risk" value={0.85} invert />
    </ThemedWrap>
  ),
};
