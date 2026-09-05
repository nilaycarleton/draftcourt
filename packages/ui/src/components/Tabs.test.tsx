import type { ReactElement } from "react";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Tabs } from "./Tabs";

/**
 * Tabs contract tests (WAI-ARIA tabs pattern). The selected-state CLASS
 * contract matters beyond semantics: `.dc-tabs-tab-selected` must mark the
 * selected tab so styling can emphasize it WITHOUT changing glyph metrics
 * (no font-weight) — a bold selected label widens and shifts sibling tabs
 * (Impeccable polish finding 1, regression-guarded here).
 */

const TABS = [
  { value: "recommendations", label: "Recommendations" },
  { value: "board", label: "Board" },
  { value: "players", label: "Available players" },
];

function Harness({ onChange }: { onChange?: (value: string) => void }): ReactElement {
  const [value, setValue] = useState("board");
  return (
    <Tabs
      value={value}
      onChange={(next) => {
        onChange?.(next);
        setValue(next);
      }}
      accessibleLabel="Draft room sections"
      tabs={TABS}
    />
  );
}

describe("Tabs", () => {
  it("renders a tablist with aria-selected on exactly the active tab", () => {
    render(<Harness />);
    const list = screen.getByRole("tablist", { name: "Draft room sections" });
    expect(list).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Board" }).getAttribute("aria-selected")).toBe("true");
    for (const name of ["Recommendations", "Available players"]) {
      expect(screen.getByRole("tab", { name }).getAttribute("aria-selected")).toBe("false");
    }
  });

  it("marks only the selected tab with dc-tabs-tab-selected", () => {
    render(<Harness />);
    const selected = screen.getByRole("tab", { name: "Board" });
    expect(selected).toHaveClass("dc-tabs-tab-selected");
    for (const name of ["Recommendations", "Available players"]) {
      expect(screen.getByRole("tab", { name })).not.toHaveClass("dc-tabs-tab-selected");
    }
  });

  it("moves selection and roving tabindex on click", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("tab", { name: "Available players" }));
    expect(
      screen.getByRole("tab", { name: "Available players" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByRole("tab", { name: "Available players" })).toHaveClass(
      "dc-tabs-tab-selected",
    );
    expect(screen.getByRole("tab", { name: "Board" }).getAttribute("tabindex")).toBe("-1");
    expect(screen.getByRole("tab", { name: "Available players" }).getAttribute("tabindex")).toBe(
      "0",
    );
  });

  it("reports every change to the controlled onChange", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(screen.getByRole("tab", { name: "Recommendations" }));
    expect(onChange).toHaveBeenCalledWith("recommendations");
  });

  it("keeps focus roving with arrow keys without changing selection", async () => {
    render(<Harness />);
    const board = screen.getByRole("tab", { name: "Board" });
    board.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Available players" })).toHaveFocus();
    // Arrow keys move FOCUS in the tabs pattern; selection follows activation
    // (click/Enter/Space), so the selected tab is unchanged here.
    expect(screen.getByRole("tab", { name: "Board" }).getAttribute("aria-selected")).toBe("true");
  });
});
