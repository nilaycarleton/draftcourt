import Link from "next/link";
import { getCurrentUser } from "@/lib/server/auth";
import { listHistoryForOwner } from "@/lib/server/history";
import { HistoryWorkspace } from "@/features/history/HistoryWorkspace";

export const dynamic = "force-dynamic";
export const metadata = { title: "Draft History — DraftCourt" };

export default async function HistoryPage() {
  const user = await getCurrentUser();
  if (!user) {
    return (
      <main className="dc-page">
        <header className="dc-page-header">
          <h1>Draft history</h1>
        </header>
        <p className="dc-hint">
          Sign in to view your saved drafts. Demo drafts are not included in authenticated history.
        </p>
        <p>
          <Link className="dc-button-primary" href="/sign-in">
            Sign in
          </Link>
        </p>
      </main>
    );
  }

  const { drafts, nextCursor } = await listHistoryForOwner(user.id, { limit: 20 });

  const items = drafts.map((d) => ({
    id: d.id,
    leagueName: d.leagueId ? `League ${d.leagueId.slice(0, 8)}` : "—",
    season: d.season ?? undefined,
    type: d.type as "REAL" | "MOCK",
    status: d.status as "SETUP" | "ACTIVE" | "PAUSED" | "COMPLETED" | "ABANDONED",
    updatedAt: d.updatedAt.toISOString(),
    grade: d.grade ?? null,
    gradeScore: d.gradeScore ?? null,
    hasAnalysis: d.hasAnalysis,
  }));

  return (
    <main className="dc-page">
      <HistoryWorkspace items={items} nextCursor={nextCursor} totalCount={items.length} />
    </main>
  );
}
