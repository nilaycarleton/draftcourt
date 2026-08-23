import { Badge as AstryxBadge } from "@astryxdesign/core/Badge";
import type { ReactNode } from "react";

export type DraftCourtBadgeVariant = "neutral" | "info" | "success" | "warning" | "danger";

export interface BadgeProps {
  children: ReactNode;
  variant?: DraftCourtBadgeVariant;
}

const variantMap: Record<
  DraftCourtBadgeVariant,
  "neutral" | "info" | "success" | "warning" | "error"
> = {
  neutral: "neutral",
  info: "info",
  success: "success",
  warning: "warning",
  danger: "error",
};

/** DraftCourt's stable Badge contract over Astryx's beta Badge. */
export function Badge({ children, variant = "neutral" }: BadgeProps) {
  return <AstryxBadge variant={variantMap[variant]} label={children} />;
}
