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

/** Same as formatPercent, but prefixes a gain with "+" -- for a return
 *  figure where the sign itself is the point (e.g. a scoreboard's total
 *  return), not just a magnitude. */
export function formatSignedPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value > 0 ? `+${formatPercent(value)}` : formatPercent(value);
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

/** `new Date("2026-09-30")` parses a bare "YYYY-MM-DD" string as UTC
 *  midnight, not local midnight -- the browser then renders that instant in
 *  the reader's own timezone, which rolls the displayed date back by one
 *  everywhere west of UTC (a 9/30 expiration briefly reads "Sep 29" for a US
 *  reader). Appending a local-midnight time-of-day before parsing sidesteps
 *  that; a value that already carries its own time/offset (a real instant,
 *  not a plain calendar date) is left to `new Date` as-is, since local
 *  display is already correct for those. */
export function parseDateOnly(value: string): Date {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value);
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = parseDateOnly(value);
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

/** Time-only for a same-day wake-up (formatTime, above), but a bare M/DD
 *  date once it's from a previous day -- a lone time ("2:14 PM") reads as
 *  "this morning" even when it's actually from last week, so the moment it
 *  isn't today this switches to something that can't be misread that way. */
export function formatLastWoke(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  if (isToday) return formatTime(value);
  return `${date.getMonth() + 1}/${String(date.getDate()).padStart(2, "0")}`;
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
