// Tiny inline equity-curve preview for a standings row -- deliberately no
// axes/labels, just shape. EquityChart.tsx is the full version with scales,
// baseline and a hover tooltip.

export interface SparklinePoint {
  at: string;
  value: number;
}

export function Sparkline({
  points,
  width = 72,
  height = 24,
  color,
}: {
  points: SparklinePoint[];
  width?: number;
  height?: number;
  color: string;
}) {
  const pad = 2;

  // Fewer than 2 points can't draw a shape -- a flat dashed placeholder
  // reads as "no movement yet" rather than an empty cell.
  if (points.length < 2) {
    return (
      <svg width={width} height={height} aria-hidden="true">
        <line
          x1={pad}
          y1={height / 2}
          x2={width - pad}
          y2={height / 2}
          stroke={color}
          strokeWidth={1.5}
          strokeDasharray="2 3"
          opacity={0.4}
        />
      </svg>
    );
  }

  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = (width - pad * 2) / (points.length - 1);

  const d = points
    .map((p, i) => {
      const x = pad + i * stepX;
      const y = pad + (1 - (p.value - min) / range) * (height - pad * 2);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg width={width} height={height} aria-hidden="true">
      <path d={d} fill="none" stroke={color} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
