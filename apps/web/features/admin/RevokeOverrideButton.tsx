"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function RevokeOverrideButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleClick() {
    setPending(true);
    try {
      await fetch(`/api/v1/admin/projection-overrides/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "revoke" }),
      });
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      className="dc-button-ghost"
      onClick={() => {
        void handleClick();
      }}
      disabled={pending}
    >
      {pending ? "Revoking…" : "Revoke"}
    </button>
  );
}
