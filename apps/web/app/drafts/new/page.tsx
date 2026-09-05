import Link from "next/link";
import { cpuPersonalities } from "@draftcourt/domain";
import { getCurrentUser } from "@/lib/server/auth";
import { getLeagueDetail, listLeagues } from "@/lib/server/leagues";
import { StartDraftFlow, type StartDraftLeague } from "@/features/drafts/StartDraftFlow";

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
  // Phase 3B: each choice needs its resolved strategy selection (league
  // preference + user default) for the preview flow.
  const details = await Promise.all(
    leagues.map(async (league) => getLeagueDetail(user.id, league.id)),
  );
  const choices: StartDraftLeague[] = leagues.flatMap((_league, index) => {
    const detail = details[index];
    if (!detail) return [];
    return [
      {
        id: detail.id,
        name: detail.name,
        type: detail.type,
        userDraftSlot: detail.userDraftSlot,
        teamCount: detail.teamCount,
        strategySelection: {
          preferredProfileId: detail.strategySelection.preferredProfileId,
          preferredProfileName: detail.strategySelection.preferredProfileName,
          defaultProfileId: detail.strategySelection.defaultProfileId,
          defaultProfileName: detail.strategySelection.defaultProfileName,
        },
      },
    ];
  });

  return (
    <main className="dc-page">
      <header className="dc-page-header">
        <h1>Choose a league</h1>
      </header>
      {choices.length === 0 ? (
        <p className="dc-hint">
          No leagues yet. <Link href="/leagues/new">Create one</Link> to start drafting. Existing
          league settings live on each <Link href="/dashboard">league&rsquo;s page</Link>.
        </p>
      ) : (
        <StartDraftFlow
          leagues={choices}
          personalities={cpuPersonalities.map((personality) => ({
            key: personality.key,
            title: personality.displayName,
            description: personality.description,
          }))}
        />
      )}
    </main>
  );
}
