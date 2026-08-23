import { Card as AstryxCard } from "@astryxdesign/core/Card";
import type { CardProps as AstryxCardProps } from "@astryxdesign/core/Card";
import type { ReactNode } from "react";

export interface CardProps {
  children: ReactNode;
  padding?: "sm" | "md" | "lg";
  className?: string;
}

// Astryx's Card takes a numeric spacing-scale step, not a size name.
const paddingStepMap: Record<
  NonNullable<CardProps["padding"]>,
  NonNullable<AstryxCardProps["padding"]>
> = {
  sm: 2,
  md: 4,
  lg: 6,
};

/** DraftCourt's stable Card contract over Astryx's beta Card. */
export function Card({ children, padding = "md", className }: CardProps) {
  return (
    <AstryxCard padding={paddingStepMap[padding]} {...(className ? { className } : {})}>
      {children}
    </AstryxCard>
  );
}
