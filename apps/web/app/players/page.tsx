import { listPlayers } from "@/lib/server/players";
import { playersQuerySchema, toPlayerListQuery } from "@/lib/server/players-query";
import { PlayerFilterForm } from "@/features/players/PlayerFilterForm";
import { PlayerResults } from "@/features/players/PlayerResults";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Players — DraftCourt",
};

interface PlayersPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function PlayersPage({ searchParams }: PlayersPageProps) {
  const rawParams = await searchParams;
  const singleValued = Object.fromEntries(
    Object.entries(rawParams).map(([key, value]) => [key, firstValue(value)]),
  );

  const parsed = playersQuerySchema.safeParse(singleValued);
  const query = parsed.success ? parsed.data : playersQuerySchema.parse({});
  const result = await listPlayers(toPlayerListQuery(query));

  return (
    <main className="dc-page">
      <header className="dc-page-header">
        <h1>Players</h1>
        <p className="dc-page-subtitle">
          Searchable player pool with DraftCourt&apos;s baseline projections, internal rank, and
          demo ADP.
        </p>
        <div className="dc-demo-banner" role="note">
          <strong>DEMO — SYNTHETIC DATA.</strong> Player names/teams/positions are real; every
          statistic and projection is fabricated for demonstration. See{" "}
          <a href="/data-sources">data sources</a> and <a href="/methodology">methodology</a>.
        </div>
        {!result.meta.runId && (
          <div className="dc-freshness-banner" role="alert">
            No baseline projection has been published yet — the player pool is empty. Run{" "}
            <code>pnpm demo:ingest</code> and{" "}
            <code>uv run python -m app.pipelines.cli publish</code>.
          </div>
        )}
      </header>

      <PlayerFilterForm query={query} />

      <PlayerResults result={result} query={query} />
    </main>
  );
}
