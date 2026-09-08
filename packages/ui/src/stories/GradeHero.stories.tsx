import type { Meta, StoryObj } from "@storybook/react-vite";
import { GradeHero } from "../components/GradeHero";

const meta: Meta<typeof GradeHero> = {
  title: "DraftCourt/GradeHero",
  component: GradeHero,
  parameters: { layout: "padded" },
};

export default meta;
type Story = StoryObj<typeof GradeHero>;

const CHECKSUM = "abc123def4567890abc123def4567890abc123def4567890abc123def4567890";
const GENERATED_AT = "2026-08-30T14:00:00.000Z";

export const GradeA: Story = {
  args: {
    grade: "A",
    gradeScore: 93.5,
    analysisVersion: "1.0.0",
    inputChecksum: CHECKSUM,
    generatedAt: GENERATED_AT,
    confidence: "HIGH",
  },
};

export const GradeB: Story = {
  args: {
    grade: "B+",
    gradeScore: 84.3,
    analysisVersion: "1.0.0",
    inputChecksum: CHECKSUM,
    generatedAt: GENERATED_AT,
    confidence: "MEDIUM",
  },
};

export const GradeC: Story = {
  args: {
    grade: "C",
    gradeScore: 71.0,
    analysisVersion: "1.0.0",
    inputChecksum: CHECKSUM,
    generatedAt: GENERATED_AT,
    confidence: "MEDIUM",
  },
};

export const GradeD: Story = {
  args: {
    grade: "D",
    gradeScore: 58.1,
    analysisVersion: "1.0.0",
    inputChecksum: CHECKSUM,
    generatedAt: GENERATED_AT,
    confidence: "LOW",
  },
};

export const GradeF: Story = {
  args: {
    grade: "F",
    gradeScore: 41.6,
    analysisVersion: "1.0.0",
    inputChecksum: CHECKSUM,
    generatedAt: GENERATED_AT,
    confidence: "LOW",
  },
};

export const ConfidenceVariants: Story = {
  render: () => (
    <div style={{ display: "grid", gap: "var(--dc-space-4)", maxWidth: 640 }}>
      <GradeHero grade="A-" gradeScore={91.7} analysisVersion="1.0.0" confidence="HIGH" />
      <GradeHero grade="B" gradeScore={82.0} analysisVersion="1.0.0" confidence="MEDIUM" />
      <GradeHero grade="C+" gradeScore={73.2} analysisVersion="1.0.0" confidence="LOW" />
    </div>
  ),
};
