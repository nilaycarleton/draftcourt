import { getCurrentUser } from "@/lib/server/auth";
import { getDraftForOwner } from "@/lib/server/drafts";
import { DraftRoom } from "@/features/drafts/DraftRoom";

export const dynamic = "force-dynamic";
export const metadata = { title: "Live draft — DraftCourt" };

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function DraftRoomPage({ params }: PageProps) {
  const user = await getCurrentUser();
  if (!user) {
    return (
      <main className="dc-page">
        <h1>Live draft</h1>
        <p className="dc-hint">Sign in to run your draft. This surface is authenticated.</p>
      </main>
    );
  }
  const { id } = await params;
  const draft = await getDraftForOwner(id, user.id);
  if (!draft) {
    return (
      <main className="dc-page">
        <h1>Draft not found</h1>
        <p className="dc-hint">It may belong to another manager.</p>
      </main>
    );
  }

  return (
    <main className="dc-page dc-draft-page">
      <DraftRoom
        draftId={draft.id}
        initial={{
          version: draft.version,
          status: draft.status,
          nextOverallPick: draft.nextOverallPick,
          currentSequence: draft.currentSequence,
          boardSize: draft.boardSize,
          settingsSnapshot: {
            teamCount: draft.settingsSnapshot.teamCount,
            rounds: draft.settingsSnapshot.rounds,
            userDraftSlot: draft.settingsSnapshot.userDraftSlot,
            scoringRules: draft.settingsSnapshot.scoringRules.map((rule) => ({
              stat: rule.stat,
              weight: rule.weight,
            })),
            teams: draft.settingsSnapshot.teams,
          },
          teams: draft.teams.map((team) => ({
            slot: team.slot,
            displayName: team.displayName,
            isUserTeam: team.isUserTeam,
            assignments: team.assignments.map((a) => ({
              playerId: a.playerId,
              playerName: a.playerName,
              sequence: typeof a.sequence === "number" ? a.sequence : 0,
              round: a.round,
              pickInRound: a.pickInRound,
              isKeeper: a.isKeeper,
              slotPosition: a.slotPosition,
              isBench: a.isBench,
            })),
          })),
          strategy: draft.strategy ?? undefined,
          mock:
            draft.type === "MOCK" && draft.mock !== null
              ? { simSeed: draft.mock.simSeed, teams: draft.mock.teams }
              : undefined,
        }}
      />
    </main>
  );
}
