import { Avatar } from "@draftcourt/ui";

/** Thin wrapper so every call site doesn't have to re-derive
 * `exactOptionalPropertyTypes`-safe optional-color props from a possibly-
 * null `team`. */
export function PlayerAvatar({
  name,
  team,
  size,
  decorative = false,
}: {
  name: string;
  team: { colorPrimary: string; colorSecondary: string } | null;
  size?: "sm" | "md" | "lg";
  decorative?: boolean;
}) {
  return (
    <Avatar
      name={name}
      decorative={decorative}
      {...(size ? { size } : {})}
      {...(team ? { colorPrimary: team.colorPrimary, colorSecondary: team.colorSecondary } : {})}
    />
  );
}
