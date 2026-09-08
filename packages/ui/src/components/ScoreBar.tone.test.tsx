import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GradeHero } from "./GradeHero";
import { ScoreBar } from "./ScoreBar";

/**
 * Phase 3F Impeccable: the grade-hero bar band follows the LETTER band so
 * the fill never contradicts the letter color (an F must not render a brown
 * "solid" bar next to a red-risk letter).
 */

function fillOf(label: string): string {
  render(<ScoreBar label={label} value={0.416} />);
  const group = screen.getByRole("group", { name: new RegExp(label) });
  const fill = group.querySelector(".dc-score-bar-fill");
  if (!(fill instanceof HTMLElement)) throw new Error("score bar fill missing");
  return fill.style.backgroundColor;
}

describe("ScoreBar tone", () => {
  it("keeps the default quartile mapping without a tone override", () => {
    // 0.416 sits in the [0.25, 0.5) quartile → solid band.
    expect(fillOf("Quartile check")).toBe("var(--dc-color-score-solid)");
  });

  it("honors an explicit tone override", () => {
    render(<ScoreBar label="Tone check" value={0.416} tone="risky" />);
    const group = screen.getByRole("group", { name: /Tone check/ });
    const fill = group.querySelector(".dc-score-bar-fill");
    if (!(fill instanceof HTMLElement)) throw new Error("score bar fill missing");
    expect(fill.style.backgroundColor).toBe("var(--dc-color-score-risky)");
  });

  it("paints an F grade bar with the risky band, not the quartile solid", () => {
    render(<GradeHero grade="F" gradeScore={41.6} />);
    const hero = screen.getByRole("img", { name: /Grade F/ });
    const fill = hero.parentElement?.querySelector(".dc-score-bar-fill");
    if (!(fill instanceof HTMLElement)) throw new Error("score bar fill missing");
    expect(fill.style.backgroundColor).toBe("var(--dc-color-score-risky)");
  });

  it("paints an A grade bar with the elite band", () => {
    render(<GradeHero grade="A" gradeScore={93.5} />);
    const hero = screen.getByRole("img", { name: /Grade A/ });
    const fill = hero.parentElement?.querySelector(".dc-score-bar-fill");
    if (!(fill instanceof HTMLElement)) throw new Error("score bar fill missing");
    expect(fill.style.backgroundColor).toBe("var(--dc-color-score-elite)");
  });
});
