import Link from "next/link";
import { getCurrentUser } from "@/lib/server/auth";
import { listLeagues } from "@/lib/server/leagues";

export const dynamic = "force-dynamic";
export const metadata = { title: "Start a draft — DraftCourt" };

export default async function NewDraftPage() {
  const user = await getCurrentUser();
  if (!user) {
    return (
      <main className="dc-page">
        <h1>Start a draft</h1>
        <p className="dc-hint">Sign in first — drafts are private to their owner.</p>
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
        <h1>Choose a league</h1>
      </header>
      {leagues.length === 0 ? (
        <p className="dc-hint">
          No leagues yet. <Link href="/leagues/new">Create one</Link> to start drafting.
        </p>
      ) : (
        <ul className="dc-league-list">
          {leagues.map((league) => (
            <li key={league.id}>
              <Link href={`/leagues/${league.id}/settings`}>{league.name}</Link>
              {" · "}
              {league.type} · slot {league.userDraftSlot} of {league.teamCount}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
