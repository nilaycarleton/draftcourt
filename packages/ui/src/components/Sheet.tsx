import {
  Dialog as AstryxDialog,
  DialogHeader as AstryxDialogHeader,
} from "@astryxdesign/core/Dialog";
import type { ReactNode } from "react";

/**
 * DraftCourt's stable sheet/dialog contract over Astryx's beta Dialog
 * (docs/adr/0003-ui-and-motion.md). `purpose="info"` allows Escape and
 * backdrop dismissal; the caller restores focus to the invoking control via
 * `onClose` (the invoking control may be a virtualized board header that
 * scrolled away, so callers treat this callback as the restore point).
 */
export interface SheetProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

export function Sheet({ isOpen, onClose, title, children }: SheetProps): ReactNode {
  return (
    <AstryxDialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      purpose="info"
    >
      <AstryxDialogHeader
        title={title}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      />
      {children}
    </AstryxDialog>
  );
}
