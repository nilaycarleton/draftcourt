import type { Meta, StoryObj } from "@storybook/react-vite";
import { useDraftCourtTheme } from "../ThemeProvider";

const meta: Meta = {
  title: "DraftCourt/Design Tokens",
};

export default meta;
type Story = StoryObj;

const swatchGroups: { label: string; tokens: string[] }[] = [
  {
    label: "Surface",
    tokens: [
      "--dc-color-canvas",
      "--dc-color-surface",
      "--dc-color-surface-elevated",
      "--dc-color-border",
    ],
  },
  {
    label: "Text",
    tokens: ["--dc-color-text-primary", "--dc-color-text-secondary", "--dc-color-text-muted"],
  },
  {
    label: "Feedback",
    tokens: ["--dc-color-success", "--dc-color-warning", "--dc-color-danger"],
  },
  {
    label: "Draft score bands",
    tokens: [
      "--dc-color-score-elite",
      "--dc-color-score-strong",
      "--dc-color-score-solid",
      "--dc-color-score-risky",
    ],
  },
  {
    label: "Chart series",
    tokens: [
      "--dc-chart-series-1",
      "--dc-chart-series-2",
      "--dc-chart-series-3",
      "--dc-chart-series-4",
      "--dc-chart-series-5",
      "--dc-chart-series-6",
    ],
  },
];

function ThemeShowcase() {
  const { resolvedTheme, preference, setPreference } = useDraftCourtTheme();

  return (
    <div
      style={{
        background: "var(--dc-color-canvas)",
        color: "var(--dc-color-text-primary)",
        padding: "var(--dc-space-5)",
        borderRadius: "var(--dc-radius-lg)",
        fontFamily: "var(--dc-font-sans)",
      }}
    >
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1.5rem" }}>
        {(["system", "light", "dark"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => {
              setPreference(option);
            }}
            style={{
              minHeight: "var(--dc-touch-target-min)",
              padding: "0 1rem",
              borderRadius: "var(--dc-radius-md)",
              border: `1px solid var(--dc-color-border)`,
              background:
                preference === option ? "var(--dc-color-accent)" : "var(--dc-color-surface)",
              color:
                preference === option
                  ? "var(--dc-color-text-on-accent)"
                  : "var(--dc-color-text-primary)",
              cursor: "pointer",
            }}
          >
            {option}
          </button>
        ))}
      </div>
      <p style={{ color: "var(--dc-color-text-secondary)" }}>
        Resolved theme: <strong>{resolvedTheme}</strong>
      </p>
      {swatchGroups.map((group) => (
        <div key={group.label} style={{ marginBottom: "1.5rem" }}>
          <h3
            style={{ fontSize: "var(--dc-font-size-sm)", color: "var(--dc-color-text-secondary)" }}
          >
            {group.label}
          </h3>
          <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
            {group.tokens.map((token) => (
              <div key={token} style={{ textAlign: "center" }}>
                <div
                  style={{
                    width: 64,
                    height: 64,
                    borderRadius: "var(--dc-radius-md)",
                    background: `var(${token})`,
                    border: "1px solid var(--dc-color-border)",
                    boxShadow: "var(--dc-shadow-sm)",
                  }}
                />
                <code style={{ fontSize: "var(--dc-font-size-xs)" }}>{token}</code>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export const LightAndDark: Story = {
  render: () => <ThemeShowcase />,
};
