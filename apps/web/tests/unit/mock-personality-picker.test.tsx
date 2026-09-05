import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  MockPersonalityPicker,
  type CpuPersonalityOption,
} from "../../../../packages/ui/src/components/MockPersonalityPicker";

/**
 * Phase 3C unit coverage for the packages/ui MockPersonalityPicker:
 * visible key/title/description, native keyboard radio semantics,
 * "Follow default" mapping to null, and disabled propagation.
 */

const personalities: CpuPersonalityOption[] = [
  { key: "playmaker", title: "Playmaker", description: "Chases high-assist playmakers early." },
  { key: "risk-taker", title: "Risk Taker", description: "Reaches for upside." },
];

describe("MockPersonalityPicker", () => {
  it("renders key, title and description visibly for every option", () => {
    render(
      <MockPersonalityPicker
        personalities={personalities}
        value="playmaker"
        onChange={() => undefined}
      />,
    );
    expect(screen.getByRole("radio", { name: /Playmaker/ })).toBeChecked();
    expect(screen.getByText("Chases high-assist playmakers early.")).toBeVisible();
    expect(screen.getByText("playmaker")).toBeVisible();
    expect(screen.getByRole("radio", { name: /Risk Taker/ })).not.toBeChecked();
    expect(screen.getByText("risk-taker")).toBeVisible();
  });

  it("offers a Follow default option that reports null", async () => {
    const onChange = vi.fn();
    render(
      <MockPersonalityPicker personalities={personalities} value="playmaker" onChange={onChange} />,
    );
    await userEvent.click(screen.getByRole("radio", { name: /Follow default/ }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("reports the selected personality key on change", async () => {
    const onChange = vi.fn();
    render(
      <MockPersonalityPicker personalities={personalities} value={null} onChange={onChange} />,
    );
    await userEvent.click(screen.getByRole("radio", { name: /Risk Taker/ }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("risk-taker");
  });

  it("moves selection with native arrow-key radio behaviour", async () => {
    const onChange = vi.fn();
    render(
      <MockPersonalityPicker personalities={personalities} value="playmaker" onChange={onChange} />,
    );
    // Native roving focus: the CHECKED radio carries the group's tab stop.
    await userEvent.tab();
    expect(screen.getByRole("radio", { name: /Playmaker/ })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(onChange).toHaveBeenCalledWith("risk-taker");
  });

  it("propagates disabled to every radio including Follow default", () => {
    render(
      <MockPersonalityPicker
        personalities={personalities}
        value="risk-taker"
        disabled
        onChange={() => undefined}
      />,
    );
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).toBeDisabled();
    }
  });

  it("groups options under an accessible name from the label prop", () => {
    render(
      <MockPersonalityPicker
        personalities={personalities}
        value={null}
        onChange={() => undefined}
        label="Default CPU personality"
      />,
    );
    expect(screen.getByRole("group", { name: "Default CPU personality" })).toBeInTheDocument();
  });
});
