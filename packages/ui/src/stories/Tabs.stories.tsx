import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Tabs } from "../components/Tabs";

/**
 * Mobile draft-room section tabs (WAI-ARIA tabs pattern). Used by the
 * Playwright Storybook suite to regression-guard the selected state: emphasis
 * must never change glyph metrics (no font-weight), so activating a tab does
 * not shift sibling tabs (Impeccable polish finding 1).
 */
const meta: Meta<typeof Tabs> = {
  title: "Draft/RoomTabs",
  component: Tabs,
  parameters: {
    layout: "padded",
  },
};

export default meta;
type Story = StoryObj<typeof Tabs>;

const TABS = [
  { value: "recommendations", label: "Recommendations" },
  { value: "board", label: "Board" },
  { value: "players", label: "Available players" },
  { value: "roster", label: "My roster" },
];

function TabsHarness(): React.ReactElement {
  const [value, setValue] = useState("recommendations");
  return (
    <Tabs value={value} onChange={setValue} accessibleLabel="Draft room sections" tabs={TABS} />
  );
}

export const fourRoomTabs: Story = {
  render: () => <TabsHarness />,
};
