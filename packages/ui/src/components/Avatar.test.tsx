import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Avatar } from "./Avatar";

describe("Avatar", () => {
  it("uses the team's own secondary color as text when it already has enough contrast", () => {
    // Lakers: purple bg, gold text — a real pair that passes 4.5:1.
    render(
      <Avatar name="LeBron James" colorPrimary="#552583" colorSecondary="#FDB927" decorative />,
    );
    const el = screen.getByText("LJ");
    expect(el).toHaveStyle({ backgroundColor: "#552583", color: "#FDB927" });
  });

  it("falls back to a high-contrast color when the team's own pair fails WCAG AA", () => {
    // Celtics green/gold — found via axe-core: 1.97:1, fails 4.5:1.
    // Regression guard for the exact pair the E2E run flagged.
    render(
      <Avatar name="Jaylen Brown" colorPrimary="#007A33" colorSecondary="#BA9653" decorative />,
    );
    const el = screen.getByText("JB");
    expect(el).toHaveStyle({ backgroundColor: "#007A33" });
    const color = getComputedStyle(el).color;
    expect(color === "rgb(255, 255, 255)" || color === "rgb(0, 0, 0)").toBe(true);
    expect(color).not.toBe("rgb(186, 150, 83)"); // #BA9653 — the failing pair
  });

  it("falls back for another real failing pair (Timberwolves blue/orange)", () => {
    render(
      <Avatar
        name="Karl-Anthony Towns"
        colorPrimary="#006BB6"
        colorSecondary="#F58426"
        decorative
      />,
    );
    const el = screen.getByText("KT");
    const color = getComputedStyle(el).color;
    expect(color === "rgb(255, 255, 255)" || color === "rgb(0, 0, 0)").toBe(true);
  });

  it("passes non-hex (CSS variable) inputs through unchanged", () => {
    render(<Avatar name="Free Agent" decorative />);
    const el = screen.getByText("FA");
    expect(el).toHaveStyle({ color: "var(--dc-color-surface-elevated)" });
  });

  it("renders an accessible name when not decorative", () => {
    render(<Avatar name="Cade Cunningham" colorPrimary="#C8102E" colorSecondary="#1D42BA" />);
    expect(
      screen.getByRole("img", { name: "Cade Cunningham (no photo available)" }),
    ).toBeInTheDocument();
  });
});
