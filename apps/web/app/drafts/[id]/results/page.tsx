/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable react-hooks/error-boundaries */
import Link from "next/link";
import type { AnalysisComponent } from "@draftcourt/domain";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/server/auth";
import {
  getOrGenerateAnalysisForOwner,
  AnalysisNotReadyError,
  AnalysisNotFoundError,
} from "@/lib/server/analysis";
import { GradeHero } from "@/features/results/GradeHero";
import { GradeBreakdown } from "@/features/results/GradeBreakdown";
import { RoundValueTable } from "@/features/results/RoundValueTable";
import { StrengthWeaknessSection } from "@/features/results/StrengthWeaknessSection";
import { StandingDistribution } from "@/features/results/StandingDistribution";

export const dynamic = "force-dynamic";

interface ResultsPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params: _params }: ResultsPageProps) {
  return { title: `Draft Results — DraftCourt` };
}

export default async function ResultsPage({ params }: ResultsPageProps) {
  const { id: draftId } = await params;
  const user = await getCurrentUser();
  if (!user) {
    return (
      <main className="dc-page">
        <header className="dc-page-header">
          <h1>Draft Results</h1>
        </header>
        <p className="dc-hint">Sign in to view your draft results.</p>
        <p>
          <Link className="dc-button-primary" href="/sign-in">
            Sign in
          </Link>
        </p>
      </main>
    );
  }

  try {
    const { analysis } = (await getOrGenerateAnalysisForOwner(draftId, user.id)) as {
      analysis: {
        grade: string;
        gradeScore: number;
        gradeComponents: Record<string, unknown>;
        assumptions: Record<string, unknown>;
        categoryStrengths: unknown;
        positionStrengths: unknown;
        roundByRound: unknown[];
        projectedStanding: unknown;
        dataFreshness: Record<string, unknown>;
        generatedAt: Date;
        analysisVersion: string;
        inputChecksum: string;
        bestValuePick?: unknown;
        biggestReach?: unknown;
        categoryWinProbs?: unknown;
      };
      cached: boolean;
    };

    const grade = analysis.grade;
    const score = analysis.gradeScore;
    const components = analysis.gradeComponents as unknown as AnalysisComponent[];

    return (
      <main className="dc-page dc-results-page">
        <header className="dc-page-header">
          <h1>Draft Results</h1>
          <p className="dc-hint">
            Grade uses projected data vs a replacement-built opponent — not a guarantee.
          </p>
        </header>

        <nav aria-label="Breadcrumb" className="dc-results-breadcrumb">
          <Link href="/dashboard">Dashboard</Link> &gt; <Link href="/history">History</Link> &gt;
          Results
        </nav>

        <section aria-labelledby="grade-heading" className="dc-results-grade">
          <h2 id="grade-heading">Overall grade</h2>
          <GradeHero grade={grade} gradeScore={score} />
          <p role="note" className="dc-results-note">
            This analysis is a projection, not a guarantee — it is based on pre-season projections
            and market data vs a replacement-built opponent and does not predict real standings.
          </p>
          <p className="dc-hint">
            Analysis version {analysis.analysisVersion} · input{" "}
            {analysis.inputChecksum.slice(0, 12)}… · generated{" "}
            {new Date(analysis.generatedAt).toLocaleString()}
          </p>
        </section>

        <section aria-labelledby="breakdown-heading">
          <h2 id="breakdown-heading">Grade breakdown</h2>
          <GradeBreakdown components={components} />
        </section>

        <section aria-labelledby="round-value-heading">
          <h2 id="round-value-heading">Round-by-round value</h2>
          <RoundValueTable
            rows={(Array.isArray(analysis.roundByRound) ? analysis.roundByRound : []) as never}
          />
        </section>

        <section aria-labelledby="strengths-heading">
          <h2 id="strengths-heading">Strengths and weaknesses</h2>
          <StrengthWeaknessSection
            categoryStrengths={
              (Array.isArray(analysis.categoryStrengths) ? analysis.categoryStrengths : []) as never
            }
            positionStrengths={
              (Array.isArray(analysis.positionStrengths) ? analysis.positionStrengths : []) as never
            }
          />
        </section>

        <section aria-labelledby="standing-heading">
          <h2 id="standing-heading">Projected standing</h2>
          <StandingDistribution
            points={
              Array.isArray((analysis.projectedStanding as { distribution?: unknown }).distribution)
                ? ((analysis.projectedStanding as { distribution: number[] }).distribution.map(
                    (v, i) => ({ rank: i + 1, count: v }),
                  ) as never)
                : []
            }
            p50={(analysis.projectedStanding as { p50?: number }).p50 ?? null}
            p90={(analysis.projectedStanding as { p90?: number }).p90 ?? null}
          />
          <p className="dc-hint">Seeded 2000 simulations vs replacement-built opponent.</p>
        </section>

        <section aria-labelledby="freshness-heading">
          <h2 id="freshness-heading">Provenance and assumptions</h2>
          <pre className="dc-results-provenance">
            {JSON.stringify(analysis.dataFreshness, null, 2)}
          </pre>
          <pre className="dc-results-provenance">
            {JSON.stringify(analysis.assumptions, null, 2)}
          </pre>
          <p role="note" className="dc-results-note">
            Confidence and data freshness are shown above. This analysis is a projection, not a
            guarantee.
          </p>
        </section>

        <p>
          <Link href={`/drafts/${draftId}`}>Back to draft room</Link>
        </p>
      </main>
    );
  } catch (error) {
    if (error instanceof AnalysisNotFoundError) return notFound();
    if (error instanceof AnalysisNotReadyError) {
      return (
        <main className="dc-page">
          <header className="dc-page-header">
            <h1>Draft Results</h1>
          </header>
          <div role="status" className="dc-results-degraded">
            <h2>Analysis not ready</h2>
            <p>{error.message} — complete the draft to generate a grade.</p>
            <p role="note">This draft must be COMPLETED before analysis is available.</p>
          </div>
        </main>
      );
    }
    throw error;
  }
}
