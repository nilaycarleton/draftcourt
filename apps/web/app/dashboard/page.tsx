import Link from "next/link";
import { getCurrentUser } from "@/lib/server/auth";
import { listLeagues } from "@/lib/server/leagues";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboard — DraftCourt" };

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) {
    return (
      <main className="dc-page">
        <header className="dc-page-header">
          <h1>Dashboard</h1>
        </header>
        <p className="dc-hint">
          Sign in to manage your leagues and drafts. Without Clerk keys configured, authenticated
          surfaces stay intentionally locked (see ADR 0009).
        </p>
        <p>
          <Link className="dc-button-primary" href="/sign-in">
            Sign in
          </Link>
        </p>
      </main>
    );
  }

  const { leagues } = await listLeagues(user.id);
  return (
    <main className="dc-page">
      <header className="dc-page-header">
        <h1>Your leagues</h1>
        <Link className="dc-button-primary" href="/leagues/new">
          Create a league
        </Link>
      </header>
      {leagues.length === 0 ? (
        <p className="dc-hint">No leagues yet — create your first one.</p>
      ) : (
        <ul className="dc-league-list">
          {leagues.map((league) => (
            <li key={league.id}>
              <Link href={`/leagues/${league.id}/settings`}>
                {league.name} · {league.type} · {league.teamCount} teams · v
                {league.settingsVersionNumber}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <h2>Live drafts</h2>
      <p>
        <Link href="/drafts/new">Start or resume a draft</Link>
      </p>
    </main>
  );
}
