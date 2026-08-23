import { listDataSources } from "@/lib/server/data-sources";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Data sources — DraftCourt",
};

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "Never";
}

const STATUS_LABEL: Record<string, string> = {
  SUCCEEDED: "Succeeded",
  FAILED: "Failed",
  RUNNING: "Running",
  PENDING: "Pending",
};

export default async function DataSourcesPage() {
  const sources = await listDataSources();

  return (
    <main className="dc-page">
      <header className="dc-page-header">
        <h1>Data sources</h1>
        <p className="dc-page-subtitle">
          Every source DraftCourt&apos;s player pool is built from, what it&apos;s permitted to be
          used for, and how fresh its last successful import was.
        </p>
        <div className="dc-demo-banner" role="note">
          <strong>DEMO — SYNTHETIC DATA.</strong> This Phase 1 build has no live, permitted NBA data
          source wired in. Every source below reads from a committed, deterministic demo dataset
          (real player/team/position facts, fabricated statistics) through the same adapter
          framework a live source would use. See <a href="/methodology">methodology</a> for how
          it&apos;s turned into projections.
        </div>
      </header>

      {sources.length === 0 ? (
        <div className="dc-empty-state" role="status">
          <p>No data sources are registered yet.</p>
        </div>
      ) : (
        <ul className="dc-source-list">
          {sources.map((source) => (
            <li key={source.id} className="dc-profile-section">
              <div className="dc-source-header">
                <h2>{source.name}</h2>
                <span className="dc-status-tag dc-status-unsigned">{source.adapterType}</span>
                {!source.enabled && (
                  <span className="dc-status-tag dc-status-suspended">DISABLED</span>
                )}
              </div>
              <p className="dc-profile-note">{source.attribution}</p>
              <div className="dc-source-meta-grid">
                <div>
                  <span className="dc-stat-card-label">Permitted uses</span>
                  <div className="dc-badge-row">
                    {source.permittedUses.map((use) => (
                      <span key={use} className="dc-status-tag dc-status-rookie">
                        {use}
                      </span>
                    ))}
                  </div>
                </div>
                <div>
                  <span className="dc-stat-card-label">Terms</span>
                  <p className="dc-profile-note">
                    {source.termsUrl ? (
                      <a href={source.termsUrl}>{source.termsUrl}</a>
                    ) : (
                      "N/A — internal demo dataset"
                    )}
                  </p>
                </div>
                <div>
                  <span className="dc-stat-card-label">Last attempted</span>
                  <p className="dc-profile-note">{formatDate(source.freshness.lastAttemptedAt)}</p>
                </div>
                <div>
                  <span className="dc-stat-card-label">Last successful</span>
                  <p className="dc-profile-note">{formatDate(source.freshness.lastSuccessfulAt)}</p>
                </div>
                <div>
                  <span className="dc-stat-card-label">Last run status</span>
                  <p className="dc-profile-note">
                    {source.freshness.lastStatus
                      ? (STATUS_LABEL[source.freshness.lastStatus] ?? source.freshness.lastStatus)
                      : "No runs yet"}
                  </p>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
