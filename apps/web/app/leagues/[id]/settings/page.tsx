import Link from "next/link";
import { getCurrentUser } from "@/lib/server/auth";
import { getLeagueDetail } from "@/lib/server/leagues";
import { getDefaultProfile, listProfiles } from "@/lib/server/preference-profiles";
import { StrategyProfilePicker } from "@/features/leagues/StrategyProfilePicker";

export const dynamic = "force-dynamic";
export const metadata = { title: "League settings — DraftCourt" };

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function LeagueSettingsPage({ params }: PageProps) {
  const user = await getCurrentUser();
  if (!user) {
    return (
      <main className="dc-page">
        <h1>League settings</h1>
        <p className="dc-hint">Sign in to view your leagues.</p>
      </main>
    );
  }
  const { id } = await params;
  const detail = await getLeagueDetail(user.id, id);
  if (!detail) {
    return (
      <main className="dc-page">
        <h1>League not found</h1>
        <p className="dc-hint">Leagues are private to their owner.</p>
      </main>
    );
  }
  // Owner-scoped profile list + current default for the strategy picker.
  const [{ profiles }, defaultProfile] = await Promise.all([
    listProfiles(user.id, { limit: 100 }),
    getDefaultProfile(user.id),
  ]);

  return (
    <main className="dc-page">
      <header className="dc-page-header">
        <h1>{detail.name}</h1>
        <span className="dc-hint">
          Settings v{detail.settingsVersionNumber} (immutable history)
        </span>
      </header>
      <section aria-label="Configuration">
        <h2>Scoring</h2>
        <ul className="dc-rule-list">
          {detail.settings.scoringRules.map((rule) => (
            <li key={rule.stat}>
              {rule.stat} ×{rule.weight}
              {rule.direction === "LOWER_BETTER" ? " (lower better)" : ""}
              {rule.punt ? " · PUNT" : ""}
            </li>
          ))}
        </ul>
        <h2>Roster</h2>
        <ul className="dc-rule-list">
          {detail.settings.rosterSlots.map((slot) => (
            <li key={slot.position}>
              {slot.count} × {slot.position}
              {slot.isStarter ? "" : " (bench)"}
            </li>
          ))}
        </ul>
        <h2>Teams</h2>
        <ol>
          {detail.teams.map((team) => (
            <li key={team.id}>
              Slot {team.slot}: {team.displayName}
              {team.isUserTeam ? " (you)" : ""}
            </li>
          ))}
        </ol>
      </section>
      <StrategyProfilePicker
        leagueId={detail.id}
        profiles={profiles.map((profile) => ({
          id: profile.id,
          name: profile.name,
          presetKey: profile.presetKey,
          presetVersion: profile.presetVersion,
          isDefault: profile.isDefault,
        }))}
        selection={{
          preferredProfileId: detail.strategySelection.preferredProfileId,
          preferredProfileName: detail.strategySelection.preferredProfileName,
          defaultProfileId: defaultProfile?.id ?? null,
          defaultProfileName: defaultProfile?.name ?? null,
        }}
      />
      <p>
        <Link className="dc-button-primary" href="/drafts/new">
          Start a draft with this league
        </Link>
      </p>
    </main>
  );
}
