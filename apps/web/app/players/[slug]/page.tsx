import { notFound } from "next/navigation";
import { getPlayerProfile } from "@/lib/server/player-profile";
import { PlayerProfile } from "@/features/players/PlayerProfile";

export const dynamic = "force-dynamic";

interface PlayerProfilePageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PlayerProfilePageProps) {
  const { slug } = await params;
  const profile = await getPlayerProfile(slug);
  if (!profile) return { title: "Player not found — DraftCourt" };
  return { title: `${profile.displayName} — DraftCourt` };
}

export default async function PlayerProfilePage({ params }: PlayerProfilePageProps) {
  const { slug } = await params;
  const profile = await getPlayerProfile(slug);
  if (!profile) notFound();

  return (
    <main className="dc-page dc-page-narrow">
      <PlayerProfile profile={profile} />
    </main>
  );
}
