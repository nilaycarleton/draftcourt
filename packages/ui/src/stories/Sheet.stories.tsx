import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Sheet } from "../components/Sheet";

/**
 * Opponent-roster sheet (Astryx Dialog behind the DraftCourt contract).
 * Used by the Playwright Storybook suite to verify at 200% browser zoom that
 * the dialog fits the viewport and dismisses with Escape (Impeccable adapt
 * finding: zoom reflow).
 */
const meta: Meta<typeof Sheet> = {
  title: "Draft/RosterSheet",
  component: Sheet,
  parameters: {
    layout: "padded",
  },
};

export default meta;
type Story = StoryObj<typeof Sheet>;

function SheetHarness(): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Show opponent roster
      </button>
      <Sheet
        isOpen={open}
        onClose={() => {
          setOpen(false);
        }}
        title="Manager 7 roster"
      >
        <ul className="dc-sheet-roster">
          <li>Round 1 · Victor Wembanyama</li>
          <li>Round 2 · Luka Dončić (keeper)</li>
        </ul>
      </Sheet>
    </div>
  );
}

export const openableRosterSheet: Story = {
  render: () => <SheetHarness />,
};
