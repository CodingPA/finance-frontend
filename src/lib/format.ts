import type { RunwayStatus } from "./companies";

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

/** Same abbreviation rules as formatUsd, but prefixes a gain with "+" --
 *  formatUsd already handles the "-" sign, so only the positive case needs
 *  anything extra. For a P/L-style figure where the sign itself is the
 *  point, not just a magnitude. */
export function formatSignedUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value > 0 ? `+${formatUsd(value)}` : formatUsd(value);
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

export function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `$${value.toFixed(2)}`;
}

export function formatMultiple(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${value.toFixed(1)}×`;
}

export function formatYears(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${value.toFixed(1)} yr`;
}

/** Runway has two null-but-distinct states alongside the computed figure --
 *  render each explicitly rather than collapsing them into the same "—". */
export function formatRunway(status: RunwayStatus, years: number | null | undefined): string {
  if (status === "profitable") return "Profitable";
  if (status === "unknown") return "Unknown";
  return formatYears(years);
}

/** mm:ss, or h:mm:ss once it's over an hour -- for media playback length. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatShares(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString();
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Date-only is ambiguous for anything priced intraday -- include the time
 *  (and the reader's own timezone abbreviation, since a quote timestamp is
 *  meaningless without knowing which clock it's on). */
/** Time only, no date -- for a same-day log (e.g. a trade feed) where the
 *  date is implied by context and repeating it on every row is just noise. */
export function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
