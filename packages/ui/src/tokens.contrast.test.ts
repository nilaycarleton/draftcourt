import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Phase 3F theme/contrast gate (M4): parses the canonical token source
 * (tokens.css) and asserts WCAG contrast for the text/surface pairings the
 * product relies on, in BOTH themes. Catches token regressions without a
 * browser; Playwright + axe remain the behavioral gates.
 */

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "tokens.css"), "utf8");

/** Extracts `--name: value` pairs from a CSS block body. */
function parseBlock(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) out.set(name.trim(), value.trim());
  }
  return out;
}

/** Splits top-level `{...}` blocks (handles one nesting level for @media). */
function topBlocks(source: string): string[] {
  const blocks: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        blocks.push(source.slice(start + 1, i));
        start = -1;
      }
    }
  }
  return blocks;
}

function themeTokens(theme: "light" | "dark"): Map<string, string> {
  const merged = new Map<string, string>();
  for (const block of topBlocks(css)) {
    for (const [name, value] of parseBlock(block)) merged.set(name, value);
    // Nested blocks (e.g. :root inside @media) override their parents.
    for (const nested of topBlocks(block)) {
      for (const [name, value] of parseBlock(nested)) {
        if (theme === "dark") merged.set(name, value);
      }
    }
  }
  // Re-resolve per theme: light = base :root only; dark = base + dark
  // overrides. The base :root block is always first; dark overrides come
  // from the prefers-color-scheme block and [data-theme="dark"].
  if (theme === "light") {
    const base = new Map<string, string>();
    for (const [name, value] of parseBlock(topBlocks(css)[0] ?? "")) base.set(name, value);
    return base;
  }
  return merged;
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;
  const value = parseInt(full, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function luminance([r, g, b]: [number, number, number]): number {
  const channel = (c: number): number => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(fgHex: string, bgHex: string): number {
  const l1 = luminance(hexToRgb(fgHex));
  const l2 = luminance(hexToRgb(bgHex));
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** Map lookup that throws a descriptive error instead of yielding undefined. */
function required(tokens: Map<string, string>, name: string): string {
  const value = tokens.get(name);
  if (value === undefined) throw new Error(`missing --${name}`);
  return value;
}

const REQUIRED_TOKENS = [
  "dc-color-canvas",
  "dc-color-surface",
  "dc-color-surface-elevated",
  "dc-color-surface-glass",
  "dc-color-border",
  "dc-color-border-strong",
  "dc-color-text-primary",
  "dc-color-text-secondary",
  "dc-color-text-muted",
  "dc-color-text-on-accent",
  "dc-color-accent",
  "dc-color-accent-strong",
  "dc-color-focus-ring",
  "dc-color-success",
  "dc-color-warning",
  "dc-color-danger",
  "dc-color-success-surface",
  "dc-color-warning-surface",
  "dc-color-danger-surface",
  "dc-color-score-elite",
  "dc-color-score-strong",
  "dc-color-score-solid",
  "dc-color-score-risky",
  "dc-motion-duration-fast",
  "dc-motion-duration-default",
  "dc-motion-duration-slow",
  "dc-motion-ease-standard",
  "dc-touch-target-min",
];

// [label, foreground token, background token, minimum ratio]
const TEXT_PAIRS: [string, string, string, number][] = [
  ["primary on surface", "dc-color-text-primary", "dc-color-surface", 4.5],
  ["secondary on surface", "dc-color-text-secondary", "dc-color-surface", 4.5],
  ["muted on surface", "dc-color-text-muted", "dc-color-surface", 4.5],
  ["primary on canvas", "dc-color-text-primary", "dc-color-canvas", 4.5],
  ["secondary on canvas", "dc-color-text-secondary", "dc-color-canvas", 4.5],
  ["muted on canvas", "dc-color-text-muted", "dc-color-canvas", 4.5],
];

describe("DraftCourt design tokens (Phase 3F M4)", () => {
  for (const theme of ["light", "dark"] as const) {
    describe(`${theme} theme`, () => {
      it("defines every required semantic token", () => {
        const tokens = themeTokens(theme);
        for (const name of REQUIRED_TOKENS) {
          expect(tokens.get(name), `missing --${name} in ${theme}`).toBeTruthy();
        }
      });

      it("keeps light and dark surfaces distinct (not an inverted afterthought)", () => {
        const tokens = themeTokens(theme);
        expect(tokens.get("dc-color-canvas")).toBeTruthy();
        expect(tokens.get("dc-color-surface")).toBeTruthy();
      });

      it("meets WCAG AA text contrast (4.5:1) on core pairings", () => {
        const tokens = themeTokens(theme);
        for (const [label, fg, bg, min] of TEXT_PAIRS) {
          const fgValue = required(tokens, fg);
          const bgValue = required(tokens, bg);
          expect(fgValue, `${label}: --${fg} missing`).toMatch(/^#[0-9a-f]{6}$/i);
          expect(bgValue, `${label}: --${bg} missing`).toMatch(/^#[0-9a-f]{6}$/i);
          const ratio = contrast(fgValue, bgValue);
          expect(
            ratio,
            `${theme} ${label}: ${fgValue} on ${bgValue} = ${ratio.toFixed(2)}:1, need ${String(min)}:1`,
          ).toBeGreaterThanOrEqual(min);
        }
      });

      it("keeps the focus ring perceivable (3:1 non-text) against surfaces", () => {
        const tokens = themeTokens(theme);
        const ring = required(tokens, "dc-color-focus-ring");
        const surface = required(tokens, "dc-color-surface");
        expect(ring).toMatch(/^#[0-9a-f]{6}$/i);
        expect(surface).toMatch(/^#[0-9a-f]{6}$/i);
        const ratio = contrast(ring, surface);
        expect(ratio, `${theme} focus ring ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
      });
    });
  }

  it("light and dark canvases differ (equal-quality themes, not filters)", () => {
    expect(themeTokens("light").get("dc-color-canvas")).not.toBe(
      themeTokens("dark").get("dc-color-canvas"),
    );
  });
});
