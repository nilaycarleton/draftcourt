import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import {
  MockPersonalityPicker,
  type CpuPersonalityOption,
} from "../components/MockPersonalityPicker";

/**
 * Stories render without the consuming app's stylesheet (the canonical
 * dc-mock-* rules live in apps/web/app/phase3c-mock.css and cannot be
 * imported across the package boundary), so a minimal scoped copy of the
 * picker rules is injected per story below. Keep in sync with the app file.
 */

const STORY_STYLES = `
.dc-mock-personality-picker { border: 0; display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; }
.dc-mock-personality-legend { font-weight: 600; padding: 0; }
.dc-mock-personality-option { align-items: center; border-bottom: 1px solid rgba(128,128,128,.25); column-gap: 8px; display: flex; min-height: 44px; padding: 8px 0; }
.dc-mock-personality-option input[type="radio"] { accent-color: var(--dc-color-accent, #b24a00); block-size: 44px; inline-size: 20px; margin: 0; }
.dc-mock-personality-option-title { font-weight: 600; }
.dc-mock-personality-option-description { color: var(--dc-color-text-secondary, inherit); flex-basis: 100%; font-size: .875rem; order: 3; }
.dc-mock-personality-option-key { color: var(--dc-color-text-muted, inherit); flex-basis: 100%; font-family: ui-monospace, monospace; font-size: .75rem; order: 4; }
`;

function StoryFrame({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 16 }}>
      <style>{STORY_STYLES}</style>
      {children}
    </div>
  );
}

const meta: Meta<typeof MockPersonalityPicker> = {
  title: "DraftCourt/MockPersonalityPicker",
  component: MockPersonalityPicker,
  parameters: { layout: "padded" },
};

export default meta;
type Story = StoryObj<typeof MockPersonalityPicker>;

const PERSONALITIES: CpuPersonalityOption[] = [
  {
    key: "playmaker",
    title: "Playmaker",
    description: "Chases high-assist playmakers early.",
  },
  {
    key: "risk-taker",
    title: "Risk Taker",
    description: "Reaches for upside; tolerates bust weeks.",
  },
  {
    key: "safe-hands",
    title: "Safe Hands",
    description: "Prefers durable, consistent floor players.",
  },
];

function PickerDemo({ initial }: { initial: string | null }) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <div style={{ maxWidth: 480 }}>
      <MockPersonalityPicker personalities={PERSONALITIES} value={value} onChange={setValue} />
    </div>
  );
}

export const Default: Story = {
  render: () => (
    <StoryFrame>
      <PickerDemo initial={null} />
    </StoryFrame>
  ),
};

export const Selected: Story = {
  render: () => (
    <StoryFrame>
      <PickerDemo initial="risk-taker" />
    </StoryFrame>
  ),
};
