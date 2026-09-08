import type { Meta, StoryObj } from "@storybook/react-vite";
import { Sparkline } from "../components/Sparkline";

const meta: Meta<typeof Sparkline> = {
  title: "DraftCourt/Sparkline",
  component: Sparkline,
  parameters: { layout: "padded" },
};

export default meta;
type Story = StoryObj<typeof Sparkline>;

function DataTable({ rows }: { rows: { label: string; value: number }[] }) {
  return (
    <table className="dc-data-table">
      <caption>Same values as the chart above.</caption>
      <thead>
        <tr>
          <th scope="col">Label</th>
          <th scope="col" className="dc-numeric">
            Value
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <td>{row.label}</td>
            <td className="dc-numeric dc-tabular">{row.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const trendPoints = [
  { label: "Week 1", value: 0.2 },
  { label: "Week 2", value: 0.35 },
  { label: "Week 3", value: 0.3 },
  { label: "Week 4", value: 0.55 },
  { label: "Week 5", value: 0.7 },
  { label: "Week 6", value: 0.9 },
];

const flatPoints = [
  { label: "Week 1", value: 0.5 },
  { label: "Week 2", value: 0.5 },
  { label: "Week 3", value: 0.5 },
  { label: "Week 4", value: 0.5 },
];

const singlePoint = [{ label: "Week 1", value: 0.5 }];

export const Trend: Story = {
  render: () => (
    <div style={{ display: "grid", gap: "var(--dc-space-3)", maxWidth: 480 }}>
      <Sparkline points={trendPoints} />
      <DataTable rows={trendPoints} />
    </div>
  ),
};

export const Flat: Story = {
  render: () => (
    <div style={{ display: "grid", gap: "var(--dc-space-3)", maxWidth: 480 }}>
      <Sparkline points={flatPoints} />
      <DataTable rows={flatPoints} />
    </div>
  ),
};

export const SinglePoint: Story = {
  render: () => (
    <div style={{ display: "grid", gap: "var(--dc-space-3)", maxWidth: 480 }}>
      <Sparkline points={singlePoint} />
      <DataTable rows={singlePoint} />
    </div>
  ),
};
