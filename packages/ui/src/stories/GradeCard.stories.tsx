import type { Meta, StoryObj } from "@storybook/react-vite";
import { GradeHero } from "../components/GradeHero";
import { GradeBreakdown } from "../components/GradeBreakdown";
import { RoundValueTable, type RoundValueRow } from "../components/RoundValueTable";
import { StrengthWeaknessCards } from "../components/StrengthWeaknessCards";
import { StandingDistribution } from "../components/StandingDistribution";

const meta: Meta = {
  title: "DraftCourt/Grade & Results",
  parameters: { layout: "padded" },
};
export default meta;

const breakdownComponents = [
  { key: "valueCaptured", value: 0.82, reason: "Mean ADP value above replacement vs pool." },
  {
    key: "projectedStrength",
    value: 0.76,
    reason: "Season fantasy points / category win probability.",
  },
  { key: "rosterBalance", value: 0.68, reason: "Gini of position counts and bench waste." },
  { key: "risk", value: 0.71, reason: "Safety from injury risk and interval width." },
  { key: "scoringFit", value: 0.84, reason: "Punt leakage and category emphasis fit." },
];

const roundRows: RoundValueRow[] = [
  {
    round: 1,
    pickInRound: 4,
    overallPick: 4,
    playerName: "Nikola Jokic",
    playerId: "p1",
    valueAboveReplacement: 18.4,
    adpDelta: -8,
    isBestValue: true,
  },
  {
    round: 2,
    pickInRound: 9,
    overallPick: 21,
    playerName: "Shai Gilgeous-Alexander",
    playerId: "p2",
    valueAboveReplacement: 6.2,
    adpDelta: 2,
  },
  {
    round: 3,
    pickInRound: 4,
    overallPick: 28,
    playerName: "Victor Wembanyama",
    playerId: "p3",
    valueAboveReplacement: 12.1,
    adpDelta: -12,
  },
  {
    round: 4,
    pickInRound: 9,
    overallPick: 45,
    playerName: "Anthony Edwards",
    playerId: "p4",
    valueAboveReplacement: -2.3,
    adpDelta: 14,
    isBiggestReach: true,
  },
  {
    round: 5,
    pickInRound: 4,
    overallPick: 52,
    playerName: "Jayson Tatum",
    playerId: "p5",
    valueAboveReplacement: 4.8,
    adpDelta: 1,
  },
];

function ThemedWrap({ theme, children }: { theme: "light" | "dark"; children: React.ReactNode }) {
  return (
    <div
      data-theme={theme}
      style={{
        background: "var(--dc-color-canvas)",
        color: "var(--dc-color-text-primary)",
        padding: "var(--dc-space-4)",
        borderRadius: "var(--dc-radius-lg)",
        border: "1px solid var(--dc-color-border)",
      }}
    >
      {children}
    </div>
  );
}

export const GradeHeroDefault: StoryObj = {
  render: () => (
    <div style={{ maxWidth: 640, display: "grid", gap: "var(--dc-space-5)" }}>
      <GradeHero
        grade="B+"
        gradeScore={84.3}
        analysisVersion="1.0.0"
        inputChecksum="abc123def4567890abc123def4567890abc123def4567890abc123def4567890"
        generatedAt="2026-08-30T14:00:00.000Z"
        confidence="MEDIUM"
      />
    </div>
  ),
};

export const GradeHeroAllGrades: StoryObj = {
  render: () => (
    <div style={{ display: "grid", gap: "var(--dc-space-4)", maxWidth: 640 }}>
      {(["A+", "A", "B+", "B", "C", "D", "F"] as const).map((grade, index) => (
        <GradeHero
          key={grade}
          grade={grade}
          gradeScore={95 - index * 7}
          analysisVersion="1.0.0"
          inputChecksum="deadbeefcafebabe12345678"
          confidence={index < 2 ? "HIGH" : index < 4 ? "MEDIUM" : "LOW"}
        />
      ))}
    </div>
  ),
};

export const GradeHeroLight: StoryObj = {
  render: () => (
    <ThemedWrap theme="light">
      <GradeHero
        grade="A-"
        gradeScore={91.7}
        analysisVersion="1.0.0"
        inputChecksum="lightmodechecksum12345678abcdef"
        generatedAt="2026-08-30T14:00:00.000Z"
        confidence="HIGH"
      />
    </ThemedWrap>
  ),
};

export const GradeHeroDark: StoryObj = {
  render: () => (
    <ThemedWrap theme="dark">
      <GradeHero
        grade="C+"
        gradeScore={73.2}
        analysisVersion="1.0.0"
        inputChecksum="darkmodechecksum12345678abcdef"
        generatedAt="2026-08-30T14:00:00.000Z"
        confidence="LOW"
      />
    </ThemedWrap>
  ),
};

export const GradeHeroNarrow320: StoryObj = {
  render: () => (
    <div
      style={{
        maxWidth: 320,
        border: "1px dashed var(--dc-color-border-strong)",
        padding: 8,
        background: "var(--dc-color-canvas)",
      }}
    >
      <GradeHero
        grade="B"
        gradeScore={82.0}
        analysisVersion="1.0.0"
        inputChecksum="narrow320checksum12345678abcdef"
        generatedAt="2026-08-30T14:00:00.000Z"
      />
      <p
        style={{
          fontSize: "var(--dc-font-size-xs)",
          color: "var(--dc-color-text-muted)",
          margin: "8px 0 0",
        }}
      >
        320px container — must not overflow horizontally.
      </p>
    </div>
  ),
};

export const GradeBreakdownStory: StoryObj = {
  render: () => (
    <div style={{ maxWidth: 560 }}>
      <GradeBreakdown components={breakdownComponents} />
    </div>
  ),
};

export const GradeBreakdownEmpty: StoryObj = {
  render: () => (
    <div style={{ maxWidth: 560 }}>
      <GradeBreakdown components={[]} />
    </div>
  ),
};

export const RoundValueDefault: StoryObj = {
  render: () => (
    <div style={{ maxWidth: 720 }}>
      <RoundValueTable rows={roundRows} />
    </div>
  ),
};

export const RoundValueNarrow320: StoryObj = {
  render: () => (
    <div style={{ maxWidth: 320, border: "1px dashed var(--dc-color-border-strong)", padding: 8 }}>
      <RoundValueTable rows={roundRows} />
      <p
        style={{
          fontSize: "var(--dc-font-size-xs)",
          color: "var(--dc-color-text-muted)",
          margin: "8px 0 0",
        }}
      >
        Table scrolls internally; page must not overflow at 320px.
      </p>
    </div>
  ),
};

export const RoundValueEmpty: StoryObj = {
  render: () => (
    <div style={{ maxWidth: 720 }}>
      <RoundValueTable rows={[]} />
    </div>
  ),
};

export const StrengthWeaknessDefault: StoryObj = {
  render: () => (
    <div style={{ maxWidth: 720 }}>
      <StrengthWeaknessCards
        positionItems={[
          {
            key: "PG",
            label: "Point Guard",
            value: 0.82,
            tone: "strength",
            reason: "Two top-30 PGs vs replacement.",
          },
          {
            key: "C",
            label: "Center",
            value: 0.31,
            tone: "weakness",
            reason: "Thin after round 8; bench center is rank 45.",
          },
          { key: "SF", label: "Small Forward", value: 0.55, tone: "neutral" },
        ]}
        categoryItems={[
          { key: "PTS", label: "Points", value: 0.78, tone: "strength" },
          {
            key: "REB",
            label: "Rebounds",
            value: 0.34,
            tone: "weakness",
            reason: "Benched big in punt-leak check.",
          },
          { key: "AST", label: "Assists", value: 0.62, tone: "neutral" },
        ]}
      />
    </div>
  ),
};

export const StrengthWeaknessEmpty: StoryObj = {
  render: () => (
    <div style={{ maxWidth: 720 }}>
      <StrengthWeaknessCards positionItems={[]} categoryItems={[]} />
    </div>
  ),
};

export const StrengthWeaknessHighContrast: StoryObj = {
  render: () => (
    <div
      style={{
        maxWidth: 720,
        padding: 12,
        border: "2px solid var(--dc-color-border-strong)",
        background: "var(--dc-color-canvas)",
      }}
    >
      <p
        style={{
          fontSize: "var(--dc-font-size-xs)",
          color: "var(--dc-color-text-secondary)",
          margin: "0 0 8px",
        }}
      >
        High-contrast mode adds 2px borders (test via prefers-contrast: more).
      </p>
      <StrengthWeaknessCards
        positionItems={[{ key: "PF", label: "Power Forward", value: 0.88, tone: "strength" }]}
        categoryItems={[{ key: "STL", label: "Steals", value: 0.22, tone: "weakness" }]}
      />
    </div>
  ),
};

export const StandingDistributionDefault: StoryObj = {
  render: () => (
    <div style={{ maxWidth: 640 }}>
      <StandingDistribution
        points={[
          { standing: 1, probability: 0.08 },
          { standing: 2, probability: 0.14 },
          { standing: 3, probability: 0.21 },
          { standing: 4, probability: 0.18 },
          { standing: 5, probability: 0.12 },
          { standing: 6, probability: 0.09 },
          { standing: 7, probability: 0.06 },
          { standing: 8, probability: 0.04 },
          { standing: 9, probability: 0.03 },
          { standing: 10, probability: 0.02 },
          { standing: 11, probability: 0.02 },
          { standing: 12, probability: 0.01 },
        ]}
        p50={4}
        p90={8}
        simulationCount={2000}
      />
    </div>
  ),
};

export const StandingDistributionNarrow: StoryObj = {
  render: () => (
    <div style={{ maxWidth: 320, border: "1px dashed var(--dc-color-border-strong)", padding: 8 }}>
      <StandingDistribution
        points={[
          { standing: 1, probability: 8 },
          { standing: 2, probability: 14 },
          { standing: 3, probability: 21 },
          { standing: 4, probability: 18 },
          { standing: 5, probability: 12 },
          { standing: 6, probability: 9 },
        ]}
        p50={3}
        p90={5}
        simulationCount={250}
      />
    </div>
  ),
};

export const StandingDistributionEmpty: StoryObj = {
  render: () => (
    <div style={{ maxWidth: 640 }}>
      <StandingDistribution points={[]} />
    </div>
  ),
};

export const ReducedMotionNote: StoryObj = {
  render: () => (
    <div style={{ maxWidth: 640, display: "grid", gap: 12 }}>
      <p
        style={{
          fontSize: "var(--dc-font-size-sm)",
          color: "var(--dc-color-text-secondary)",
          margin: 0,
        }}
      >
        Reduced-motion: chart reveal is disabled via prefers-reduced-motion. No animated entrance is
        used.
      </p>
      <StandingDistribution
        points={[
          { standing: 1, probability: 0.12 },
          { standing: 2, probability: 0.18 },
          { standing: 3, probability: 0.22 },
          { standing: 4, probability: 0.15 },
        ]}
        p50={3}
        p90={4}
      />
    </div>
  ),
};

export const FullResultsPage: StoryObj = {
  render: () => (
    <div style={{ maxWidth: 720, display: "grid", gap: "var(--dc-space-5)" }}>
      <h1 style={{ margin: 0, fontSize: "var(--dc-font-size-xl)" }}>West End Ballers — Results</h1>
      <GradeHero
        grade="B+"
        gradeScore={84.3}
        analysisVersion="1.0.0"
        inputChecksum="fullpagechecksum12345678abcdef12345678abcdef"
        generatedAt="2026-08-30T14:00:00.000Z"
        confidence="MEDIUM"
      />
      <GradeBreakdown components={breakdownComponents} />
      <RoundValueTable rows={roundRows} />
      <StrengthWeaknessCards
        positionItems={[
          { key: "PG", label: "Point Guard", value: 0.82, tone: "strength" },
          { key: "C", label: "Center", value: 0.31, tone: "weakness" },
        ]}
        categoryItems={[
          { key: "PTS", label: "Points", value: 0.78, tone: "strength" },
          { key: "REB", label: "Rebounds", value: 0.34, tone: "weakness" },
        ]}
      />
      <StandingDistribution
        points={[
          { standing: 1, probability: 0.08 },
          { standing: 2, probability: 0.14 },
          { standing: 3, probability: 0.21 },
          { standing: 4, probability: 0.18 },
          { standing: 5, probability: 0.12 },
        ]}
        p50={4}
        p90={6}
        simulationCount={2000}
      />
    </div>
  ),
};
