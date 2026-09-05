import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { FactorSliderRow, PresetGallery, RankListEditor } from "./PreferenceControls";

describe("FactorSliderRow", () => {
  it("renders a labeled range with a percentage value and lock toggle", async () => {
    const onValueChange = vi.fn();
    const onToggleLock = vi.fn();
    render(
      <FactorSliderRow
        label="Production"
        value={0.331139}
        locked={false}
        onValueChange={onValueChange}
        onToggleLock={onToggleLock}
      />,
    );

    const slider = screen.getByRole("slider", { name: "Production" });
    expect(slider).toHaveValue("0.331139");
    expect(slider).toHaveAccessibleDescription("");
    expect(screen.getByText("33.1%")).toBeInTheDocument();

    const lock = screen.getByRole("button", { name: "Lock Production" });
    expect(lock).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(lock);
    expect(onToggleLock).toHaveBeenCalledOnce();

    fireEvent.change(slider, { target: { value: "0.5" } });
    expect(onValueChange).toHaveBeenCalledWith(0.5);
  });

  it("locks the slider and flips the lock label", () => {
    render(
      <FactorSliderRow
        label="Risk"
        value={0.4}
        locked
        onValueChange={() => undefined}
        onToggleLock={() => undefined}
      />,
    );
    expect(screen.getByRole("slider", { name: "Risk" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Unlock Risk" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

describe("PresetGallery", () => {
  const presets = [
    { key: "balanced", title: "Balanced", explanation: "The default blend." },
    { key: "win-now", title: "Win Now", explanation: "Safety today." },
  ];

  it("marks the provenance preset as pressed and fires apply for others", async () => {
    const onApply = vi.fn();
    render(<PresetGallery presets={presets} activeKey="balanced" onApply={onApply} />);
    expect(screen.getByRole("button", { name: /Balanced/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(screen.getByRole("button", { name: /Win Now/ }));
    expect(onApply).toHaveBeenCalledWith("win-now");
  });
});

describe("RankListEditor", () => {
  const items = [
    { playerId: "a", displayName: "Alpha Player" },
    { playerId: "b", displayName: "Beta Player" },
  ];

  it("exposes keyboard reordering with positional announcements", async () => {
    const onMove = vi.fn();
    render(
      <RankListEditor
        items={items}
        notes={{}}
        labelId="rank-label"
        onMove={onMove}
        onRemove={vi.fn()}
        onNoteChange={vi.fn()}
      />,
    );
    const upA = screen.getByRole("button", { name: "Move Alpha Player up to position 0" });
    expect(upA).toBeDisabled(); // already first
    await userEvent.click(
      screen.getByRole("button", { name: "Move Beta Player up to position 1" }),
    );
    expect(onMove).toHaveBeenCalledWith("b", "up");
  });

  it("edits notes and removes rows", async () => {
    const onNoteChange = vi.fn();
    const onRemove = vi.fn();
    render(
      <RankListEditor
        items={items}
        notes={{}}
        labelId="rank-label"
        onMove={vi.fn()}
        onRemove={onRemove}
        onNoteChange={onNoteChange}
      />,
    );
    await userEvent.type(screen.getByLabelText("Note for Alpha Player"), "great");
    expect(onNoteChange).toHaveBeenCalledWith("a", "g");
    await userEvent.click(screen.getByRole("button", { name: "Remove Beta Player from board" }));
    expect(onRemove).toHaveBeenCalledWith("b");
  });
});
