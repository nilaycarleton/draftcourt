export const metadata = {
  title: "Methodology — DraftCourt",
};

export default function MethodologyPage() {
  return (
    <main className="dc-page dc-page-narrow">
      <header className="dc-page-header">
        <h1>Methodology</h1>
        <p className="dc-page-subtitle">
          How DraftCourt turns a player&apos;s history into the baseline projection you see on their
          profile — in plain language, with its limitations stated up front.
        </p>
        <div className="dc-demo-banner" role="note">
          <strong>DEMO — SYNTHETIC DATA.</strong> Everything this methodology describes runs against
          a deterministic, entirely fabricated demo dataset in this build. See{" "}
          <a href="/data-sources">data sources</a> for exactly what&apos;s real vs. synthetic.
        </div>
      </header>

      <section className="dc-profile-section" aria-labelledby="what-heading">
        <h2 id="what-heading">What this model is — and isn&apos;t</h2>
        <p className="dc-profile-note">
          The current model, <code>baseline-weighted-historical</code>, is an exponentially weighted
          historical average with bounded, documented adjustments — not a trained machine-learning
          model. It exists to prove the full data-to-projection pipeline with a method that&apos;s
          completely explainable: every number it produces can be traced back to a specific formula,
          not a black box. A trained ensemble model is planned for a later phase, and it will only
          replace this one if it measurably beats it.
        </p>
      </section>

      <section className="dc-profile-section" aria-labelledby="inputs-heading">
        <h2 id="inputs-heading">Inputs and season weighting</h2>
        <p className="dc-profile-note">
          The model looks at up to a player&apos;s 3 most recent NBA seasons of per-game rates
          (points, rebounds, assists, and so on — never season totals), and weights the most recent
          season heaviest. With three seasons on file, the weights are roughly 15% / 30% / 55% from
          oldest to newest; with fewer seasons, the weights adjust accordingly. Active role signals
          (a starter change, a role bump or reduction) and player age then adjust that weighted
          baseline by a small, bounded amount — a big role change never swings a projection wildly
          on its own.
        </p>
      </section>

      <section className="dc-profile-section" aria-labelledby="pct-heading">
        <h2 id="pct-heading">Shooting percentages are always derived, never averaged</h2>
        <p className="dc-profile-note">
          FG% and FT% are never stored or averaged as their own numbers. They&apos;re always
          computed as projected makes divided by projected attempts, at the moment they&apos;re
          shown. Averaging percentages directly (instead of makes/attempts) is a common source of
          quietly wrong stat lines, so DraftCourt never does it.
        </p>
      </section>

      <section className="dc-profile-section" aria-labelledby="fallback-heading">
        <h2 id="fallback-heading">Rookies, unsigned players, and missing history</h2>
        <p className="dc-profile-note">
          A rookie with no NBA season on file falls back to their most recent college stat line, run
          through conservative translation factors (college scoring rates are discounted, for
          example, since NBA competition is harder). A player with no statistical history at all —
          real or college — gets a fixed, deliberately modest replacement-level projection rather
          than a missing or crashed one. Unsigned players get reduced projected games and minutes
          and a lower role-security score, reflecting the added uncertainty of not being on a
          roster.
        </p>
      </section>

      <section className="dc-profile-section" aria-labelledby="uncertainty-heading">
        <h2 id="uncertainty-heading">Uncertainty ranges are a labeled heuristic</h2>
        <p className="dc-profile-note">
          The 80% range shown on a player&apos;s profile is a simple, fixed-width band around the
          projection — widened further for rookies, unsigned players, and anyone with thin history.
          It is <strong>not</strong> a statistically calibrated confidence interval. Measured
          against DraftCourt&apos;s own synthetic evaluation benchmark, the true coverage of this
          band came in well below its nominal 80% target. Treat it as a rough plausible range, not a
          guarantee — genuine calibration is planned for a later, trained-model phase.
        </p>
      </section>

      <section className="dc-profile-section" aria-labelledby="overrides-heading">
        <h2 id="overrides-heading">Admin overrides and news signals</h2>
        <p className="dc-profile-note">
          DraftCourt staff can apply a manual override (say, adjusting a player&apos;s projected
          role after a confirmed trade) or log a news signal. These are always applied as an
          explicit, audited step <em>after</em> the baseline model runs — never blended silently
          into the model&apos;s own weighting — and every override requires a written rationale.
        </p>
      </section>

      <section className="dc-profile-section" aria-labelledby="rank-heading">
        <h2 id="rank-heading">What &quot;internal rank&quot; means</h2>
        <p className="dc-profile-note">
          Internal rank is a standard 9-category fantasy scoring composite, computed only against
          the other players in the same published run. It is <strong>not</strong> DraftCourt&apos;s
          real roster-aware, league-settings-aware recommendation engine — that&apos;s a
          live-draft-phase feature and doesn&apos;t exist yet. Internal rank is a simpler, honest
          stand-in until it does.
        </p>
      </section>

      <section className="dc-profile-section" aria-labelledby="disclaimer-heading">
        <h2 id="disclaimer-heading">Disclaimer</h2>
        <p className="dc-profile-note">
          DraftCourt is an independent project and is not endorsed by, affiliated with, or sponsored
          by the NBA or any NBA team. Player names, teams, and positions reflect public facts; every
          statistic and projection is fabricated for demonstration purposes only and must never be
          treated as a real forecast.
        </p>
      </section>
    </main>
  );
}
