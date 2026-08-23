/**
 * Minimal inline-SVG trend line — deliberately hand-built rather than a
 * chart-library dependency (keeps bundle size down, matches BUILD_SPEC.md
 * section 15's Motion/Anime.js restraint). Always `aria-hidden`: this
 * component is a decorative supplement, never the only presentation of the
 * data — every caller must render an adjacent visible data table with the
 * same values (BUILD_SPEC.md section 9.3: "Every chart must include an
 * accessible text summary or equivalent data table").
 */
export interface SparklinePoint {
  label: string;
  value: number;
}

export interface SparklineProps {
  points: SparklinePoint[];
  width?: number;
  height?: number;
  color?: string;
}

export function Sparkline({
  points,
  width = 160,
  height = 40,
  color = "var(--dc-color-accent)",
}: SparklineProps) {
  if (points.length === 0) return null;

  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = points.length > 1 ? width / (points.length - 1) : 0;
  const padding = 4;
  const usableHeight = height - padding * 2;

  const coords = points.map((point, index) => {
    const x = index * stepX;
    const y = padding + usableHeight - ((point.value - min) / range) * usableHeight;
    return `${String(x)},${String(y)}`;
  });

  return (
    <svg
      className="dc-sparkline"
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      width={width}
      height={height}
      aria-hidden="true"
      focusable="false"
    >
      <polyline
        points={coords.join(" ")}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {coords.map((coord, index) => {
        const [x, y] = coord.split(",");
        return <circle key={points[index]?.label ?? index} cx={x} cy={y} r={2.5} fill={color} />;
      })}
    </svg>
  );
}
