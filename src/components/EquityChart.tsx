// Hero equity-curve chart for the league page -- one line per (grouped)
// competitor, a dashed baseline at the competition's starting capital, and a
// hover crosshair + tooltip (dataviz skill: line/area charts get a hover
// layer by default). Color only ever distinguishes the emphasized/leader
// line from everyone else -- this design system has no rich categorical
// ramp, so identity among the non-emphasized lines rests on the legend/
// tooltip text, never on hue, same as the mockup this is built from (a red
// leader line against otherwise-neutral ones).

import { useMemo, useRef, useState, type MouseEvent } from "react";
import { formatUsd } from "../lib/format";

export interface EquityChartPoint {
  at: string;
  value: number;
}

export interface EquityChartSeries {
  id: string;
  label: string;
  color: string;
  points: EquityChartPoint[];
  emphasized?: boolean;
}

const VIEW_W = 720;
const MARGIN = { top: 10, right: 12, bottom: 8, left: 56 };

function niceTicks(min: number, max: number, count: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min];
  const step = (max - min) / (count - 1);
  return Array.from({ length: count }, (_, i) => min + step * i);
}

interface PlottedSeries {
  series: EquityChartSeries;
  d: string;
  pts: { x: number; y: number }[];
}

export function EquityChart({
  series,
  baseline,
  height = 220,
}: {
  series: EquityChartSeries[];
  baseline: number;
  height?: number;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);

  const plotW = VIEW_W - MARGIN.left - MARGIN.right;
  const plotH = height - MARGIN.top - MARGIN.bottom;

  const allPoints = series.flatMap((s) => s.points);
  const times = allPoints.map((p) => new Date(p.at).getTime()).filter((t) => !Number.isNaN(t));
  const values = allPoints.map((p) => p.value);

  const xMin = times.length ? Math.min(...times) : 0;
  const xMax = times.length ? Math.max(...times) : xMin + 1;
  const yMinRaw = values.length ? Math.min(...values, baseline) : baseline;
  const yMaxRaw = values.length ? Math.max(...values, baseline) : baseline;
  const yPad = (yMaxRaw - yMinRaw) * 0.12 || Math.max(baseline * 0.05, 25);
  const yMin = yMinRaw - yPad;
  const yMax = yMaxRaw + yPad;

  const xScale = (t: number) => MARGIN.left + (xMax === xMin ? plotW / 2 : ((t - xMin) / (xMax - xMin)) * plotW);
  const yScale = (v: number) => MARGIN.top + (1 - (v - yMin) / (yMax - yMin || 1)) * plotH;

  const paths: PlottedSeries[] = useMemo(
    () =>
      series.map((s) => {
        const pts = s.points
          .map((p) => {
            const t = new Date(p.at).getTime();
            if (Number.isNaN(t)) return null;
            return { x: xScale(t), y: yScale(p.value) };
          })
          .filter((p): p is { x: number; y: number } => p !== null);
        const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
        return { series: s, d, pts };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- xScale/yScale close over the domain above; series is the real dep
    [series, xMin, xMax, yMin, yMax],
  );

  const baselineY = yScale(baseline);
  // Generic value ticks, minus any that would sit within a few px of the
  // baseline label -- avoids two overlapping "$5.0K" labels on the axis.
  const yTicks = niceTicks(yMin, yMax, 3).filter((t) => Math.abs(yScale(t) - baselineY) > 12);

  const handleMove = (e: MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const x = ((e.clientX - rect.left) / rect.width) * VIEW_W;
    setHoverX(Math.max(MARGIN.left, Math.min(VIEW_W - MARGIN.right, x)));
  };

  const hoverPoints = useMemo(() => {
    if (hoverX === null) return null;
    return paths
      .filter((p) => p.pts.length > 0)
      .map(({ series: s, pts }) => {
        let nearestIdx = 0;
        let best = Infinity;
        pts.forEach((p, i) => {
          const dist = Math.abs(p.x - hoverX);
          if (dist < best) {
            best = dist;
            nearestIdx = i;
          }
        });
        return { series: s, point: pts[nearestIdx], source: s.points[nearestIdx] };
      });
  }, [hoverX, paths]);

  const hoverTime =
    hoverPoints && hoverPoints[0]
      ? new Date(hoverPoints[0].source.at).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : null;

  const noData = allPoints.length === 0;

  return (
    <div className="equity-chart">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEW_W} ${height}`}
        preserveAspectRatio="none"
        width="100%"
        height={height}
        onMouseMove={noData ? undefined : handleMove}
        onMouseLeave={() => setHoverX(null)}
        role="img"
        aria-label="Equity curves for every competitor since the competition started"
      >
        <line
          x1={MARGIN.left}
          x2={VIEW_W - MARGIN.right}
          y1={baselineY}
          y2={baselineY}
          stroke="var(--color-divider)"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
        <text x={MARGIN.left - 8} y={baselineY + 3} textAnchor="end" fontSize={10} fill="var(--color-text)" opacity={0.6}>
          {formatUsd(baseline)} start
        </text>
        {yTicks.map((t) => (
          <text key={t} x={MARGIN.left - 8} y={yScale(t) + 3} textAnchor="end" fontSize={10} fill="var(--color-text)" opacity={0.5}>
            {formatUsd(t)}
          </text>
        ))}

        {paths.map(({ series: s, d }) => (
          <path
            key={s.id}
            d={d}
            fill="none"
            stroke={s.color}
            strokeWidth={s.emphasized ? 2.5 : 1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {hoverX !== null && !noData && (
          <line x1={hoverX} x2={hoverX} y1={MARGIN.top} y2={height - MARGIN.bottom} stroke="var(--color-text)" strokeWidth={1} opacity={0.2} />
        )}

        {hoverPoints?.map((h) => (
          <circle key={h.series.id} cx={h.point.x} cy={h.point.y} r={3} fill={h.series.color} stroke="var(--color-bg)" strokeWidth={1.5} />
        ))}
      </svg>

      {noData && <p className="text-muted equity-chart-empty">No equity history yet.</p>}

      {hoverPoints && hoverPoints.length > 0 && (
        <div className="equity-chart-tooltip" style={{ left: `${(hoverX! / VIEW_W) * 100}%` }}>
          {hoverTime && <div className="equity-chart-tooltip-time">{hoverTime}</div>}
          {hoverPoints
            .slice()
            .sort((a, b) => b.source.value - a.source.value)
            .map((h) => (
              <div key={h.series.id} className="equity-chart-tooltip-row">
                <span className="equity-chart-swatch" style={{ background: h.series.color }} />
                <span>{h.series.label}</span>
                <strong>{formatUsd(h.source.value)}</strong>
              </div>
            ))}
        </div>
      )}

      <div className="equity-chart-legend">
        {series.map((s) => (
          <span key={s.id} className="equity-chart-legend-item">
            <span className="equity-chart-swatch" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}
