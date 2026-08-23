import { listAuditLog } from "@/lib/server/audit-log";

export const metadata = {
  title: "Audit log — DraftCourt admin",
};

export default async function AdminAuditLogPage() {
  const entries = await listAuditLog({ limit: 100 });

  return (
    <>
      <header className="dc-page-header">
        <h1>Audit log</h1>
        <p className="dc-page-subtitle">
          Every override and signal mutation, most recent first. Read-only — nothing here can be
          edited or deleted.
        </p>
      </header>

      <div className="dc-data-table-scroll" role="region" aria-label="Audit log table" tabIndex={0}>
        <table className="dc-data-table">
          <caption className="dc-visually-hidden">
            Admin audit log entries, most recent first
          </caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Action</th>
              <th scope="col">Entity</th>
              <th scope="col">Actor role</th>
              <th scope="col">Trace ID</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td>{new Date(entry.createdAt).toLocaleString()}</td>
                <td>{entry.action}</td>
                <td>
                  {entry.entityType} · {entry.entityId.slice(0, 8)}…
                </td>
                <td>{entry.actorRole ?? "system"}</td>
                <td>
                  <code>{entry.traceId.slice(0, 8)}…</code>
                </td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr>
                <td colSpan={5}>No audit log entries yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
