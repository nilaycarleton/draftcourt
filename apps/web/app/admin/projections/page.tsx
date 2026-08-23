import { listOverrides } from "@/lib/server/admin-overrides";
import { OverrideForm } from "@/features/admin/OverrideForm";
import { RevokeOverrideButton } from "@/features/admin/RevokeOverrideButton";

export const metadata = {
  title: "Projection overrides — DraftCourt admin",
};

function fmtValue(delta: number | null, replacement: number | null): string {
  if (replacement !== null) return `= ${replacement.toString()}`;
  if (delta !== null) return delta >= 0 ? `+${delta.toString()}` : delta.toString();
  return "—";
}

export default async function AdminProjectionsPage() {
  const overrides = await listOverrides({});

  return (
    <>
      <header className="dc-page-header">
        <h1>Projection overrides</h1>
        <p className="dc-page-subtitle">
          Manually adjust a player&apos;s baseline projection with a required rationale. Overrides
          take effect the next time a projection run is published — they don&apos;t recompute the
          current published run in place.
        </p>
      </header>

      <OverrideForm />

      <div
        className="dc-data-table-scroll"
        role="region"
        aria-label="Projection overrides table"
        tabIndex={0}
      >
        <table className="dc-data-table">
          <caption className="dc-visually-hidden">Projection overrides, most recent first</caption>
          <thead>
            <tr>
              <th scope="col">Player</th>
              <th scope="col">Season</th>
              <th scope="col">Stat</th>
              <th scope="col" className="dc-numeric">
                Value
              </th>
              <th scope="col">Status</th>
              <th scope="col">Rationale</th>
              <th scope="col">Created</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {overrides.map((override) => (
              <tr key={override.id}>
                <td>{override.playerName}</td>
                <td>{override.season}</td>
                <td>{override.stat}</td>
                <td className="dc-numeric dc-tabular">
                  {fmtValue(override.deltaValue, override.replacementValue)}
                </td>
                <td>
                  <span
                    className={`dc-status-tag dc-status-${override.status === "ACTIVE" ? "rookie" : "unsigned"}`}
                  >
                    {override.status}
                  </span>
                </td>
                <td>{override.rationale}</td>
                <td>{new Date(override.createdAt).toLocaleString()}</td>
                <td>{override.status === "ACTIVE" && <RevokeOverrideButton id={override.id} />}</td>
              </tr>
            ))}
            {overrides.length === 0 && (
              <tr>
                <td colSpan={8}>No overrides yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
