import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { lookupSharedResult, isValidShareTokenFormat } from "@/lib/server/share";
import {
  checkShareRateLimit,
  hashShareRateLimitKey,
  SHARE_RATE_LIMITS,
} from "@/lib/server/share-rate-limit";
import { SharedReplay } from "@/features/replay/SharedReplay";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Shared Draft Results — DraftCourt",
  robots: { index: false, follow: false, noarchive: true, nosnippet: true },
};

interface SharePageProps {
  params: Promise<{ token: string }>;
}

/** Single indistinguishable not-found for invalid/revoked/expired/ineligible. */
function sharedNotFound(): never {
  notFound();
}

export default async function SharedResultPage({ params }: SharePageProps) {
  const { token } = await params;

  // Rate-limit public lookups per hashed IP before any token work. Invalid
  // formats still count as failures without revealing validity.
  const headerStore = await headers();
  const ip = headerStore.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const ua = headerStore.get("user-agent");
  const lookupGated = await checkShareRateLimit(
    hashShareRateLimitKey(ip, ua),
    SHARE_RATE_LIMITS.lookup,
  );
  if (!lookupGated.allowed) {
    return (
      <main className="dc-page">
        <header className="dc-page-header">
          <h1>Shared Draft Results</h1>
        </header>
        <div role="status" className="dc-share-state">
          <h2>Too many requests</h2>
          <p>This link is temporarily rate limited. Try again in a minute.</p>
        </div>
      </main>
    );
  }

  if (!isValidShareTokenFormat(token)) {
    await checkShareRateLimit(hashShareRateLimitKey(ip, ua), SHARE_RATE_LIMITS.tokenFailure);
    sharedNotFound();
  }

  const shared = await lookupSharedResult(token);
  if (!shared) {
    await checkShareRateLimit(hashShareRateLimitKey(ip, ua), SHARE_RATE_LIMITS.tokenFailure);
    sharedNotFound();
  }

  return (
    <main className="dc-page dc-share-page">
      <header className="dc-page-header">
        <h1>{shared.title}</h1>
        <p className="dc-hint">
          Read-only shared result · {shared.leagueType} · {shared.horizon} · Grade reflects{" "}
          {shared.analyzedTeamName}
        </p>
      </header>

      <section aria-labelledby="shared-grade-heading" className="dc-share-grade">
        <h2 id="shared-grade-heading">Overall grade</h2>
        {shared.analysis.available ? (
          <>
            <p className="dc-share-grade-line">
              <strong aria-label={`Grade ${shared.analysis.grade ?? ""}`}>
                {shared.analysis.grade}
              </strong>{" "}
              <span>{String(shared.analysis.gradeScore)}</span>
            </p>
            <p role="note" className="dc-share-note">
              {shared.analysis.disclosure}
            </p>
            <p className="dc-hint">{shared.analysis.baselineNote}</p>
            <p className="dc-hint">
              Analysis version {shared.analysis.analysisVersion} · input{" "}
              {shared.analysis.inputChecksumTruncated}…
            </p>
          </>
        ) : (
          <p role="status">Analysis is unavailable for this shared result.</p>
        )}
      </section>

      <section aria-labelledby="shared-board-heading">
        <h2 id="shared-board-heading">Final board</h2>
        <div
          className="dc-table-scroll"
          role="region"
          aria-label="Final draft board in pick order, scrollable"
          tabIndex={0}
        >
          <table className="dc-replay-table">
            <caption className="dc-visually-hidden">Final draft board in pick order</caption>
            <thead>
              <tr>
                <th scope="col">Pick</th>
                <th scope="col">Round</th>
                <th scope="col">Team</th>
                <th scope="col">Player</th>
              </tr>
            </thead>
            <tbody>
              {shared.board.map((pick) => (
                <tr key={`${String(pick.overallPick)}-${String(pick.teamSlot)}`}>
                  <td>{pick.overallPick}</td>
                  <td>{pick.round}</td>
                  <td>{pick.teamName}</td>
                  <td>{pick.playerName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="shared-rosters-heading">
        <h2 id="shared-rosters-heading">Final rosters</h2>
        <ul className="dc-replay-rosters">
          {shared.rosters.map((roster) => (
            <li key={roster.teamSlot}>
              <strong>{roster.teamName}</strong>
              <ul>
                {roster.players.map((player) => (
                  <li key={`${String(player.overallPick)}-${player.playerName}`}>
                    {player.playerName}
                    {player.slotPosition ? ` · ${player.slotPosition}` : ""}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </section>

      <SharedReplay
        timeline={shared.timeline}
        board={shared.board}
        integrityOk={shared.integrity.ok}
        integrityDetail={shared.integrity.detail}
      />

      <section aria-labelledby="shared-provenance-heading">
        <h2 id="shared-provenance-heading">Provenance</h2>
        <p role="note" className="dc-share-note">
          {shared.analysis.disclosure} {shared.analysis.baselineNote}
        </p>
      </section>
    </main>
  );
}
