/**
 * Initials-and-team-color fallback — DraftCourt never uses real player/team
 * photos (BUILD_SPEC.md section 20 / data/attribution/demo-dataset.md).
 * This is not a "loading" fallback for a missing image; it is the only
 * visual DraftCourt ever renders for a player.
 */
export interface AvatarProps {
  name: string;
  colorPrimary?: string;
  colorSecondary?: string;
  size?: "sm" | "md" | "lg";
  /** Set false when adjacent visible text already names the player, so a
   * screen reader doesn't announce the name twice. */
  decorative?: boolean;
}

const sizeMap: Record<NonNullable<AvatarProps["size"]>, number> = { sm: 28, md: 40, lg: 72 };

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

const HEX_COLOR = /^#([0-9a-f]{6})$/i;
const MIN_TEXT_CONTRAST = 4.5;

function hexToRgb(hex: string): [number, number, number] | null {
  const match = HEX_COLOR.exec(hex);
  if (!match?.[1]) return null;
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(hexA: string, hexB: string): number | null {
  const rgbA = hexToRgb(hexA);
  const rgbB = hexToRgb(hexB);
  if (!rgbA || !rgbB) return null;
  const lA = relativeLuminance(rgbA);
  const lB = relativeLuminance(rgbB);
  return (Math.max(lA, lB) + 0.05) / (Math.min(lA, lB) + 0.05);
}

/** Team colors are arbitrary (30 teams, real-world brand pairs) — several
 * genuinely fail WCAG AA text contrast against their own team's other
 * color (e.g. Celtics green/gold: 1.97:1), found via axe-core E2E runs.
 * Prefers the team's own secondary color when it already has enough
 * contrast (keeps the two-tone team-branded look for teams where it
 * works), falling back to whichever of pure white/black contrasts better
 * against the primary color otherwise. Non-hex inputs (the semantic
 * `var(--dc-color-*)` defaults for players with no team) pass through
 * unchanged — those token pairings are already balanced by design. */
function accessibleTextColor(background: string, preferred: string): string {
  const preferredContrast = contrastRatio(background, preferred);
  if (preferredContrast === null) return preferred;
  if (preferredContrast >= MIN_TEXT_CONTRAST) return preferred;

  const whiteContrast = contrastRatio(background, "#ffffff") ?? 0;
  const blackContrast = contrastRatio(background, "#000000") ?? 0;
  return whiteContrast >= blackContrast ? "#ffffff" : "#000000";
}

export function Avatar({
  name,
  colorPrimary = "var(--dc-color-text-muted)",
  colorSecondary = "var(--dc-color-surface-elevated)",
  size = "md",
  decorative = false,
}: AvatarProps) {
  const px = sizeMap[size];
  const textColor = accessibleTextColor(colorPrimary, colorSecondary);
  return (
    <span
      className="dc-avatar"
      style={{
        width: px,
        height: px,
        backgroundColor: colorPrimary,
        color: textColor,
        fontSize: px * 0.4,
      }}
      role={decorative ? "presentation" : "img"}
      aria-label={decorative ? undefined : `${name} (no photo available)`}
    >
      {initials(name)}
    </span>
  );
}
