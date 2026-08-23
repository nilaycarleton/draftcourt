import type { ReactNode } from "react";
import Link from "next/link";
import { getCurrentUser } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();

  if (!user) {
    return (
      <main className="dc-page">
        <div className="dc-empty-state" role="alert">
          <h1>Sign-in required</h1>
          <p>You need to be signed in with an admin account to view this page.</p>
        </div>
      </main>
    );
  }

  if (user.role !== "ADMIN") {
    return (
      <main className="dc-page">
        <div className="dc-empty-state" role="alert">
          <h1>Admin access required</h1>
          <p>Your account doesn&apos;t have access to this area.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="dc-page">
      <nav className="dc-admin-nav" aria-label="Admin sections">
        <Link href="/admin/projections">Projection overrides</Link>
        <Link href="/admin/signals">Player signals</Link>
        <Link href="/admin/audit-log">Audit log</Link>
      </nav>
      {children}
    </main>
  );
}
