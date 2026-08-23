import { prisma } from "@draftcourt/db";

export interface PublicDataSource {
  id: string;
  name: string;
  adapterType: string;
  enabled: boolean;
  termsUrl: string | null;
  attribution: string;
  permittedUses: string[];
  lastComplianceReviewAt: string | null;
  freshness: {
    lastAttemptedAt: string | null;
    lastSuccessfulAt: string | null;
    lastStatus: string | null;
  };
}

/** Safe, public projection of `DataSource` + its most recent
 * `IngestionRun` — never exposes raw ingestion errors (BUILD_SPEC.md
 * section 8.3 / section 19: "Admin UI intentionally omits raw pipeline
 * errors"), only whether the last run succeeded. */
export async function listDataSources(): Promise<PublicDataSource[]> {
  const sources = await prisma.dataSource.findMany({
    include: {
      ingestionRuns: { orderBy: { startedAt: "desc" }, take: 5 },
    },
    orderBy: { name: "asc" },
  });

  return sources.map((source) => {
    const lastAttempt = source.ingestionRuns[0] ?? null;
    const lastSuccess = source.ingestionRuns.find((run) => run.status === "SUCCEEDED") ?? null;
    return {
      id: source.id,
      name: source.name,
      adapterType: source.adapterType,
      enabled: source.enabled,
      termsUrl: source.termsUrl,
      attribution: source.attribution,
      permittedUses: source.permittedUses,
      lastComplianceReviewAt: source.lastComplianceReviewAt?.toISOString() ?? null,
      freshness: {
        lastAttemptedAt: lastAttempt?.startedAt.toISOString() ?? null,
        lastSuccessfulAt: lastSuccess?.finishedAt?.toISOString() ?? null,
        lastStatus: lastAttempt?.status ?? null,
      },
    };
  });
}
