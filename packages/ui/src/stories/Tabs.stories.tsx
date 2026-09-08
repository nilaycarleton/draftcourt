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
    <div>
      <Tabs value={value} onChange={setValue} accessibleLabel="Draft room sections" tabs={TABS} />
      {/* Matching tabpanels: without these, the tabs' aria-controls dangle
       * (axe aria-valid-attr-value, critical) and the story is not a faithful
       * WAI-ARIA tabs pattern. Mirrors the DraftRoom panel contract. */}
      {TABS.map((tab) =>
        tab.value === value ? (
          <div
            key={tab.value}
            role="tabpanel"
            id={`dc-panel-${tab.value}`}
            aria-labelledby={`dc-tab-${tab.value}`}
            // Programmatic-focus only (-1): matches the DraftRoom tabpanel
            // contract; panels are not in the Tab order.
            tabIndex={-1}
          >
            {tab.label} panel content
          </div>
        ) : null,
      )}
    </div>
  );
}

export const fourRoomTabs: Story = {
  render: () => <TabsHarness />,
};
