import Link from "next/link";

export interface ComparePlayerOption {
  slug: string;
  label: string;
}

const SLOTS = [0, 1, 2, 3] as const;

/**
 * A plain `<form method="get">` — no client JS required (matches
 * PlayerFilterForm's "filter state lives in the URL" pattern). Selecting a
 * player in each slot and submitting produces a shareable
 * `/compare?players=slug1&players=slug2...` URL.
 */
export function ComparePicker({
  options,
  selected,
}: {
  options: ComparePlayerOption[];
  selected: string[];
}) {
  return (
    <form
      method="get"
      action="/compare"
      className="dc-filter-form"
      aria-label="Choose players to compare"
    >
      <div className="dc-filter-row">
        {SLOTS.map((slot) => (
          <label key={slot} className="dc-field">
            <span>Player {slot + 1}</span>
            <select name="players" defaultValue={selected[slot] ?? ""}>
              <option value="">—</option>
              {options.map((option) => (
                <option key={option.slug} value={option.slug}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <div className="dc-filter-actions">
        <button type="submit" className="dc-button-primary">
          Compare
        </button>
        <Link href="/compare" className="dc-button-ghost">
          Clear all
        </Link>
      </div>
    </form>
  );
}
