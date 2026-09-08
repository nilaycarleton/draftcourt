import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GradeHero } from "./GradeHero";

/**
 * Phase 3F naming contract for GradeHero (presentational-only assertions):
 * - the grade container has role="img" with an accessible name containing
 *   the grade letter;
 * - no bare aria-label on role-less elements.
 */
describe("GradeHero naming contract", () => {
  it("grade container has role=img with an accessible name containing the grade letter", () => {
    render(<GradeHero grade="B+" gradeScore={84.3} />);
    expect(screen.getByRole("img", { name: /B\+/ })).toBeInTheDocument();
  });

  it("has no bare aria-label on role-less elements", () => {
    const { container } = render(
      <GradeHero
        grade="B+"
        gradeScore={84.3}
        analysisVersion="1.0.0"
        inputChecksum="abc123def4567890abc123def4567890abc123def4567890abc123def4567890"
        generatedAt="2026-08-30T14:00:00.000Z"
        confidence="MEDIUM"
      />,
    );
    expect(container.querySelectorAll("[aria-label]:not([role])")).toHaveLength(0);
  });
});
