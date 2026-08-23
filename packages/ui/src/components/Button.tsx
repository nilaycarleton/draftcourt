import { Button as AstryxButton } from "@astryxdesign/core/Button";
import type { ReactNode } from "react";

/**
 * DraftCourt's stable Button contract. Astryx is beta and may rename/reshape
 * its own prop surface across releases — feature code depends on this
 * adapter, never on `@astryxdesign/core` directly, so an upstream breaking
 * change is absorbed in one place (docs/adr/0003-ui-and-motion.md).
 */
export type DraftCourtButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type DraftCourtButtonSize = "sm" | "md" | "lg";

export interface ButtonProps {
  /** Visible label. Also serves as the accessible name unless `accessibleLabel` is set. */
  children: string;
  /** Overrides the accessible name when the visible label isn't descriptive enough on its own. */
  accessibleLabel?: string;
  onClick?: () => void;
  variant?: DraftCourtButtonVariant;
  size?: DraftCourtButtonSize;
  disabled?: boolean;
  loading?: boolean;
  type?: "button" | "submit" | "reset";
}

const variantMap: Record<
  DraftCourtButtonVariant,
  "primary" | "secondary" | "ghost" | "destructive"
> = {
  primary: "primary",
  secondary: "secondary",
  ghost: "ghost",
  danger: "destructive",
};

export function Button({
  children,
  accessibleLabel,
  onClick,
  variant = "primary",
  size = "md",
  disabled = false,
  loading = false,
  type = "button",
}: ButtonProps): ReactNode {
  return (
    <AstryxButton
      label={accessibleLabel ?? children}
      variant={variantMap[variant]}
      size={size}
      isDisabled={disabled}
      isLoading={loading}
      type={type}
      {...(onClick ? { onClick } : {})}
    >
      {children}
    </AstryxButton>
  );
}
