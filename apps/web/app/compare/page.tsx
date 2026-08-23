import { comparePlayers } from "@/lib/server/player-profile";
import { listPlayers } from "@/lib/server/players";
import { ComparePicker } from "@/features/players/ComparePicker";
import { CompareTable } from "@/features/players/CompareTable";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Compare — DraftCourt",
};

const MIN_COMPARE = 2;
const MAX_COMPARE = 4;

function parseSlugs(raw: string | string[] | undefined): string[] {
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const flat = values.flatMap((v) => v.split(","));
  const trimmed = flat.map((v) => v.trim()).filter((v) => v.length > 0);
  return [...new Set(trimmed)];
}

interface ComparePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ComparePage({ searchParams }: ComparePageProps) {
  const rawParams = await searchParams;
  const requestedSlugs = parseSlugs(rawParams.players);
  const excess = requestedSlugs.length > MAX_COMPARE;
  const slugs = requestedSlugs.slice(0, MAX_COMPARE);

  const [profiles, pool] = await Promise.all([
    slugs.length >= MIN_COMPARE ? comparePlayers(slugs) : Promise.resolve([]),
    listPlayers({ filters: {}, sort: "displayName", direction: "asc", limit: 500 }),
  ]);

  const foundSlugs = new Set(profiles.map((p) => p.slug));
  const missing = slugs.filter((slug) => !foundSlugs.has(slug));
  // Preserve the requested order rather than whatever order the DB returned.
  const bySlug = new Map(profiles.map((profile) => [profile.slug, profile]));
  const ordered = slugs.map((slug) => bySlug.get(slug)).filter((p) => p !== undefined);

  const options = pool.players.map((p) => ({
    slug: p.slug,
    label: `${p.displayName} (${p.team?.abbreviation ?? "FA"})`,
  }));

  return (
    <main className="dc-page">
      <header className="dc-page-header">
        <h1>Compare players</h1>
        <p className="dc-page-subtitle">
          Compare baseline projections for 2–4 players side by side. Pick players below, or share
          this page&apos;s URL directly.
        </p>
        <div className="dc-demo-banner" role="note">
          <strong>DEMO — SYNTHETIC DATA.</strong> Player names/teams/positions are real; every
          statistic and projection is fabricated for demonstration. See{" "}
          <a href="/data-sources">data sources</a> and <a href="/methodology">methodology</a>.
        </div>
      </header>

      <ComparePicker options={options} selected={slugs} />

      {excess && (
        <div className="dc-freshness-banner" role="status">
          Only the first {MAX_COMPARE} selected players are compared.
        </div>
      )}

      {missing.length > 0 && (
        <div className="dc-freshness-banner" role="alert">
          No player found for: {missing.join(", ")}.
        </div>
      )}

      {slugs.length === 0 && (
        <div className="dc-empty-state" role="status">
          <p>Pick 2–4 players above to compare their baseline projections.</p>
        </div>
      )}

      {slugs.length > 0 && slugs.length < MIN_COMPARE && (
        <div className="dc-empty-state" role="status">
          <p>Pick at least one more player to compare.</p>
        </div>
      )}

      {ordered.length >= MIN_COMPARE && <CompareTable profiles={ordered} />}
    </main>
  );
}
