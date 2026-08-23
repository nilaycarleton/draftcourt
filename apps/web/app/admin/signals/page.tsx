import { listSignals } from "@/lib/server/admin-signals";
import { SignalForm } from "@/features/admin/SignalForm";
import { ExpireSignalButton } from "@/features/admin/ExpireSignalButton";

export const metadata = {
  title: "Player signals — DraftCourt admin",
};

function isActive(expiresAt: string | null): boolean {
  return expiresAt === null || new Date(expiresAt) > new Date();
}

export default async function AdminSignalsPage() {
  const signals = await listSignals({});

  return (
    <>
      <header className="dc-page-header">
        <h1>Player signals</h1>
        <p className="dc-page-subtitle">
          Log a role/injury/trade signal that the baseline model reads as an adjustment input on the
          next projection run.
        </p>
      </header>

      <SignalForm />

      <div
        className="dc-data-table-scroll"
        role="region"
        aria-label="Player signals table"
        tabIndex={0}
      >
        <table className="dc-data-table">
          <caption className="dc-visually-hidden">Player news signals, most recent first</caption>
          <thead>
            <tr>
              <th scope="col">Player</th>
              <th scope="col">Type</th>
              <th scope="col" className="dc-numeric">
                Impact
              </th>
              <th scope="col" className="dc-numeric">
                Confidence
              </th>
              <th scope="col">Rationale</th>
              <th scope="col">Effective</th>
              <th scope="col">Status</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {signals.map((signal) => {
              const active = isActive(signal.expiresAt);
              return (
                <tr key={signal.id}>
                  <td>{signal.playerName}</td>
                  <td>{signal.type}</td>
                  <td className="dc-numeric dc-tabular">{signal.impact.toFixed(2)}</td>
                  <td className="dc-numeric dc-tabular">{signal.confidence.toFixed(2)}</td>
                  <td>{signal.rationale ?? "—"}</td>
                  <td>{new Date(signal.effectiveAt).toLocaleString()}</td>
                  <td>
                    <span className={`dc-status-tag dc-status-${active ? "rookie" : "unsigned"}`}>
                      {active ? "ACTIVE" : "EXPIRED"}
                    </span>
                  </td>
                  <td>{active && <ExpireSignalButton id={signal.id} />}</td>
                </tr>
              );
            })}
            {signals.length === 0 && (
              <tr>
                <td colSpan={8}>No signals yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
