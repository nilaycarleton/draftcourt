import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../ThemeProvider";
import { Button } from "./Button";

function renderWithTheme(ui: React.ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

describe("Button", () => {
  it("renders the visible label", () => {
    renderWithTheme(<Button>Draft player</Button>);
    expect(screen.getByRole("button", { name: "Draft player" })).toBeInTheDocument();
  });

  it("calls onClick when activated", async () => {
    const onClick = vi.fn();
    renderWithTheme(<Button onClick={onClick}>Draft player</Button>);
    await userEvent.click(screen.getByRole("button", { name: "Draft player" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("does not call onClick when disabled", async () => {
    const onClick = vi.fn();
    renderWithTheme(
      <Button onClick={onClick} disabled>
        Draft player
      </Button>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Draft player" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("uses accessibleLabel as the accessible name when provided", () => {
    renderWithTheme(<Button accessibleLabel="Draft LeBron James">Draft</Button>);
    expect(screen.getByRole("button", { name: "Draft LeBron James" })).toBeInTheDocument();
  });
});
