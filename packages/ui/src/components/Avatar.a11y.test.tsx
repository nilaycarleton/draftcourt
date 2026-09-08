import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Avatar } from "./Avatar";

/**
 * Phase 3F a11y contract for Avatar (presentational-only assertions):
 * - decorative Avatars hide their initials from assistive technology
 *   (aria-hidden="true" on the initials node) and expose no accessible name;
 * - non-decorative Avatars expose the player's name.
 */
describe("Avatar a11y contract", () => {
  it("decorative Avatar hides initials from AT and exposes no accessible name", () => {
    const { container } = render(<Avatar name="LeBron James" decorative />);
    expect(screen.getByText("LJ")).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("img")).toBeNull();
    expect(container.querySelector("[aria-label]")).toBeNull();
  });

  it("non-decorative Avatar exposes the player name", () => {
    render(<Avatar name="LeBron James" />);
    expect(screen.getByRole("img", { name: /LeBron James/ })).toBeInTheDocument();
  });
});
