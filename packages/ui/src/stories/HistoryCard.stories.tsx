import type { Meta, StoryObj } from "@storybook/react-vite";
import { HistoryCard } from "../components/HistoryCard";

const meta: Meta<typeof HistoryCard> = {
  title: "DraftCourt/HistoryCard",
  component: HistoryCard,
  parameters: { layout: "padded" },
  argTypes: {
    type: { control: "select", options: ["REAL", "MOCK", "DEMO"] },
    status: { control: "select", options: ["SETUP", "ACTIVE", "PAUSED", "COMPLETED", "ABANDONED"] },
  },
};
export default meta;
type Story = StoryObj<typeof HistoryCard>;

const longName =
  "Commissioner's Extremely Long League Name That Wraps and Truncates at 320px Without Page Overflow Edition";

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
        maxWidth: 640,
      }}
    >
      {children}
    </div>
  );
}

export const Default: Story = {
  args: {
    leagueName: "West End Ballers",
    season: "2026–27",
    type: "REAL",
    status: "COMPLETED",
    updatedAt: "2026-08-30T14:00:00.000Z",
    grade: "B+",
    gradeScore: 83.4,
    summary: "12 teams · 13 rounds",
    href: "#",
    hasAnalysis: true,
  },
  render: (args) => <HistoryCard {...args} />,
};

export const LongNameTruncation: Story = {
  render: () => (
    <div style={{ maxWidth: 320, border: "1px dashed var(--dc-color-border-strong)", padding: 8 }}>
      <HistoryCard
        leagueName={longName}
        season="2026–27"
        type="MOCK"
        status="COMPLETED"
        updatedAt="2026-08-30T14:00:00.000Z"
        grade="A-"
        gradeScore={91.2}
        summary="16 teams · 19 rounds · category league"
        href="#"
        hasAnalysis
      />
      <p
        style={{
          margin: "8px 0 0",
          fontSize: "var(--dc-font-size-xs)",
          color: "var(--dc-color-text-muted)",
        }}
      >
        Container is 320px — the card must not cause horizontal page overflow.
      </p>
    </div>
  ),
};

export const NoGrade: Story = {
  render: () => (
    <HistoryCard
      leagueName="Rebuilding Year"
      type="REAL"
      status="ACTIVE"
      updatedAt={new Date().toISOString()}
      hasAnalysis={false}
      summary="10 teams · 11 rounds"
      href="#"
    />
  ),
};

export const AllStatuses: Story = {
  render: () => (
    <div style={{ display: "grid", gap: "var(--dc-space-3)", maxWidth: 560 }}>
      {(["COMPLETED", "ACTIVE", "PAUSED", "SETUP", "ABANDONED"] as const).map((status) => (
        <HistoryCard
          key={status}
          leagueName={`League ${status}`}
          type={status === "COMPLETED" ? "REAL" : "MOCK"}
          status={status}
          updatedAt="2026-08-24T10:00:00.000Z"
          grade={status === "COMPLETED" ? "C" : null}
          gradeScore={status === "COMPLETED" ? 71.0 : null}
          hasAnalysis={status === "COMPLETED"}
          href="#"
        />
      ))}
    </div>
  ),
};

export const LightTheme: Story = {
  render: () => (
    <ThemedWrap theme="light">
      <HistoryCard
        leagueName="Light Theme — Sunset Invitational"
        season="2026–27"
        type="REAL"
        status="COMPLETED"
        updatedAt="2026-08-30T14:00:00.000Z"
        grade="A"
        gradeScore={94.2}
        summary="12 teams · 13 rounds"
        href="#"
        hasAnalysis
      />
    </ThemedWrap>
  ),
};

export const DarkTheme: Story = {
  render: () => (
    <ThemedWrap theme="dark">
      <HistoryCard
        leagueName="Dark Theme — Midnight Hoops"
        season="2026–27"
        type="MOCK"
        status="COMPLETED"
        updatedAt="2026-08-30T14:00:00.000Z"
        grade="D"
        gradeScore={58.1}
        summary="12 teams · 13 rounds"
        href="#"
        hasAnalysis
      />
    </ThemedWrap>
  ),
};

export const HighContrastNarrow: Story = {
  render: () => (
    <div
      style={{
        maxWidth: 320,
        padding: 12,
        border: "2px solid var(--dc-color-border-strong)",
        background: "var(--dc-color-canvas)",
      }}
    >
      <p
        style={{
          margin: "0 0 8px",
          fontSize: "var(--dc-font-size-xs)",
          color: "var(--dc-color-text-secondary)",
        }}
      >
        High-contrast mode adds defined borders (check via prefers-contrast: more).
      </p>
      <HistoryCard
        leagueName={longName}
        type="REAL"
        status="PAUSED"
        updatedAt="2026-08-30T14:00:00.000Z"
        hasAnalysis={false}
        href="#"
      />
    </div>
  ),
};

export const ReducedMotionNote: Story = {
  render: () => (
    <div style={{ maxWidth: 560, display: "grid", gap: 12 }}>
      <p
        style={{
          margin: 0,
          fontSize: "var(--dc-font-size-sm)",
          color: "var(--dc-color-text-secondary)",
        }}
      >
        Reduced-motion: transitions disabled via prefers-reduced-motion (verify in DevTools
        emulation). This card has no animation by construction.
      </p>
      <HistoryCard
        leagueName="Reduced Motion Check"
        type="REAL"
        status="COMPLETED"
        updatedAt="2026-08-30T14:00:00.000Z"
        grade="B"
        gradeScore={82.0}
        summary="12 teams · 13 rounds"
        href="#"
        hasAnalysis
      />
    </div>
  ),
};

export const GradeValues: Story = {
  render: () => (
    <div style={{ display: "grid", gap: "var(--dc-space-3)", maxWidth: 560 }}>
      {(["A+", "A", "B+", "B", "C+", "C", "D", "F"] as const).map((grade) => (
        <HistoryCard
          key={grade}
          leagueName={`Grade ${grade} example`}
          type="MOCK"
          status="COMPLETED"
          updatedAt="2026-08-30T14:00:00.000Z"
          grade={grade}
          gradeScore={
            grade.startsWith("A")
              ? 92
              : grade.startsWith("B")
                ? 82
                : grade.startsWith("C")
                  ? 72
                  : 50
          }
          href="#"
          hasAnalysis
        />
      ))}
    </div>
  ),
};

export const InertWithoutLink: Story = {
  render: () => (
    <HistoryCard
      leagueName="Inert Card — No Action Link"
      type="REAL"
      status="SETUP"
      updatedAt="2026-08-24T10:00:00.000Z"
      summary="Draft not yet started"
    />
  ),
};

export const Zoom200Note: Story = {
  render: () => (
    <div style={{ maxWidth: 640 }}>
      <p
        style={{
          margin: "0 0 12px",
          fontSize: "var(--dc-font-size-sm)",
          color: "var(--dc-color-text-secondary)",
        }}
      >
        200% zoom check: all text must reflow without horizontal scroll. Verify by zooming browser
        to 200% — this 640px container should not overflow.
      </p>
      <HistoryCard
        leagueName={longName}
        season="2026–27 — Category League with Long Scoring Config"
        type="REAL"
        status="COMPLETED"
        updatedAt="2026-08-30T14:00:00.000Z"
        grade="B+"
        gradeScore={87.3}
        summary="12 teams · 16 rounds · Keeper · 9 categories"
        href="#"
        hasAnalysis
      />
    </div>
  ),
};
