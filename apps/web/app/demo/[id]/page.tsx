import { DraftRoom } from "@/features/drafts/DraftRoom";
import {
  getDemoDraftState,
  DemoExpiredError,
  DemoRevokedError,
  DemoNotFoundError,
  DemoCapabilityInvalidError,
} from "@/lib/server/demo-drafts";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

interface DemoPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: DemoPageProps) {
  const { id: _id } = await params;
  return { title: `Demo Draft — DraftCourt` };
}

export default async function DemoDraftPage({ params }: DemoPageProps) {
  const { id: draftId } = await params;
  const cookieStore = await cookies();
  const capabilityToken = cookieStore.get("__Secure-demo-capability")?.value;

  if (!capabilityToken) {
    return notFound();
  }

  let state: Awaited<ReturnType<typeof getDemoDraftState>>;
  try {
    state = await getDemoDraftState(draftId, capabilityToken);
  } catch (error) {
    if (
      error instanceof DemoExpiredError ||
      error instanceof DemoRevokedError ||
      error instanceof DemoNotFoundError ||
      error instanceof DemoCapabilityInvalidError
    ) {
      return notFound();
    }
    throw error;
  }

  // Transform DemoDraftState to DraftRoom initial format
  const initial = {
    version: state.version,
    status: state.status,
    nextOverallPick: state.nextOverallPick,
    currentSequence: state.currentSequence,
    boardSize: state.boardSize,
    settingsSnapshot: {
      teamCount: state.teams.length,
      rounds: state.boardSize / state.teams.length,
      userDraftSlot: state.teams.find((t) => t.isUserTeam)?.slot ?? 1,
      scoringRules: [],
      teams: state.teams.map((t) => ({
        slot: t.slot,
        displayName: t.displayName,
        isUserTeam: t.isUserTeam,
      })),
    },
    teams: state.teams.map((t) => ({
      slot: t.slot,
      displayName: t.displayName,
      isUserTeam: t.isUserTeam,
      assignments: [],
    })),
    mock: {
      simSeed: state.simulationSeed,
      teams: state.teams
        .filter((t) => !t.isUserTeam)
        .map((t) => ({
          slot: t.slot,
          displayName: t.displayName,
          isUserTeam: t.isUserTeam,
          personalityKey: t.personalityKey,
        })),
    },
  };

  return <DraftRoom draftId={draftId} initial={initial} />;
}
