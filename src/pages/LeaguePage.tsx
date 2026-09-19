// Medium-Term Paper Trading League (finance-backend/docs/paper-trading-league-rules.md,
// finance-backend/docs/league-api.md): George vs. Claude, backend-enforced rules engine.
// Only one competition is seeded today, so this page skips a competition
// picker and just loads the first one -- add a picker later if a second
// competition ever gets created.

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useIsMobile } from "../hooks/useIsMobile";
import { realtime, LeagueFeedSocket } from "../lib/ws";
import { extractGenericMessage } from "../lib/formErrors";
import {
  formatDateTime,
  formatLastWoke,
  formatPrice,
  formatShortDateTime,
  formatSignedPercent,
  formatSignedUsd,
  formatTime,
  formatUsd,
  formatUsdExact,
  parseDateOnly,
} from "../lib/format";
import { AddCompetitorModal } from "../components/AddCompetitorModal";
import { CompetitorAvatar } from "../components/CompetitorAvatar";
import { EquityChart, type EquityChartSeries } from "../components/EquityChart";
import { Sparkline } from "../components/Sparkline";
import { TradeModal } from "../components/TradeModal";
import {
  cancelTrade,
  competitorColor,
  getCompetitor,
  getEquityCurve,
  getNextWakeups,
  getScoreboard,
  listCompetitions,
  listCompetitionTrades,
  listCompetitors,
  pnlClass,
  positionPnl,
  refreshCompetition,
  tradeOrderTotal,
  triggerWakeup,
  REJECTION_CODE_LABELS,
  tradeStatusTagClass,
  type Competition,
  type CompetitionTrade,
  type CompetitorDetail,
  type CompetitorKind,
  type CompetitorSummary,
  type EquityCurveSeries,
  type ForcedCheckin,
  type Position,
  type Scoreboard,
} from "../lib/league";

const LEADER_COLOR = "var(--color-accent)";
const NOTABLE_COLOR = "var(--color-neutral-700)";
const FLAT_COLOR = "var(--color-neutral-400)";

// A competitor whose account value never strayed more than 1% from
// starting capital reads as "flat" for chart purposes -- collapsed into one
// grouped line so a handful of untouched accounts don't clutter the hero
// chart with overlapping flat lines (mirrors the mockup's "Four flat
// accounts" legend entry, which is a display grouping, not backend data).
const FLAT_THRESHOLD_PCT = 0.01;

function buildChartSeries(
  scoreboardRows: Scoreboard["competitors"],
  curve: EquityCurveSeries[] | null,
  startingCapital: number,
  colorById: Map<number, string>,
): EquityChartSeries[] {
  if (scoreboardRows.length === 0) return [];
  const curveById = new Map((curve ?? []).map((c) => [c.competitor_id, c]));
  const leaderId = scoreboardRows[0].id;
  const epsilon = startingCapital * FLAT_THRESHOLD_PCT;

  const rows = scoreboardRows.map((c) => {
    const points = (curveById.get(c.id)?.points ?? []).map((p) => ({ at: p.at, value: Number(p.account_value) }));
    const values = points.map((p) => p.value).concat(startingCapital);
    const range = Math.max(...values) - Math.min(...values);
    return { id: c.id, name: c.name, points, flat: range <= epsilon };
  });

  const leader = rows.find((r) => r.id === leaderId);
  const rest = rows.filter((r) => r.id !== leaderId);
  const notable = rest.filter((r) => !r.flat);
  const flat = rest.filter((r) => r.flat);

  const out: EquityChartSeries[] = [];
  // A competitor's own color (badges, dashboard) doubles as its chart-line
  // color when set -- falls back to the old leader/neutral split for a
  // competitor that never picked one (docs: blank color on a custom AI
  // persona means "no identity set").
  if (leader)
    out.push({
      id: `c-${leader.id}`,
      label: leader.name,
      color: colorById.get(leader.id) || LEADER_COLOR,
      points: leader.points,
      emphasized: true,
    });
  for (const r of notable)
    out.push({ id: `c-${r.id}`, label: r.name, color: colorById.get(r.id) || NOTABLE_COLOR, points: r.points });
  if (flat.length > 0) {
    // Any one flat member's own points are representative -- by definition
    // they're all within epsilon of starting capital throughout.
    const rep = flat.reduce((best, r) => (r.points.length > best.points.length ? r : best), flat[0]);
    out.push({
      id: "flat-group",
      label: `${flat.length} flat account${flat.length === 1 ? "" : "s"}`,
      color: FLAT_COLOR,
      points: rep.points,
    });
  }
  return out;
}

function formatDateRange(startDate: string, endDate: string): string {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  const startStr = start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const endStr = end.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return `${startStr} – ${endStr}`;
}

function rejectionLabel(code: string): string {
  return REJECTION_CODE_LABELS[code as keyof typeof REJECTION_CODE_LABELS] ?? code;
}

// Keeps the mobile trades list's collapsed label (ticker + instrument, e.g.
// "SPY call 768") to one short line regardless of how verbose an option
// description gets -- the full ticker/instrument is still in the expanded row.
function truncateLabel(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatShortDate(value: string | null | undefined): string {
  if (!value) return "";
  const date = parseDateOnly(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function computeDayInfo(startDate: string, endDate: string): { dayNum: number; totalDays: number } {
  const msPerDay = 86_400_000;
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const totalDays = Math.round((end.getTime() - start.getTime()) / msPerDay) + 1;
  const rawDay = Math.round((today.getTime() - start.getTime()) / msPerDay) + 1;
  return { dayNum: Math.min(Math.max(rawDay, 1), totalDays), totalDays };
}

// A refresh() POST only confirms the job was queued -- if the
// league.scoreboard_refreshed push doesn't land within this window (socket
// down, Redis hiccup), fall back to a plain re-GET instead of spinning
// forever (finance-backend/docs/league-api.md's "Building the manual-refresh button").
const REFRESH_FALLBACK_MS = 15_000;

const WAKE_ALL_MAX = 10;
const WAKE_ALL_DELAY_MS = 1000;

// Same fallback idea as REFRESH_FALLBACK_MS, but much longer -- a wake-up is
// a full LLM turn, not a quote refresh, and the backend explicitly calls out
// cases where no event ever arrives at all (a competitor with no owning
// user gets zero WS pushes). Without this a wake-up that never gets a
// terminal event would keep "Wake up all" disabled forever.
const WAKEUP_FALLBACK_MS = 5 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function LeaguePage() {
  const isMobile = useIsMobile();
  const [competition, setCompetition] = useState<Competition | null>(null);
  const [scoreboard, setScoreboard] = useState<Scoreboard | null>(null);
  const [competitors, setCompetitors] = useState<CompetitorSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [addModalOpen, setAddModalOpen] = useState(false);
  // The send loop below (POSTing each wake-up, WAKE_ALL_DELAY_MS apart) vs.
  // the outstanding wake-ups it queued, tracked by wakeup_id through
  // queued -> thinking -> cleared on the matching terminal event (or the
  // fallback timeout). The button stays disabled while either is non-empty.
  const [wakeAllSending, setWakeAllSending] = useState(false);
  const [pendingWakeups, setPendingWakeups] = useState<Map<number, "queued" | "thinking">>(new Map());
  const wakeupFallbackTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const [wakeAllError, setWakeAllError] = useState<string | null>(null);
  const [equityCurve, setEquityCurve] = useState<EquityCurveSeries[] | null>(null);
  const [nextForcedCheckin, setNextForcedCheckin] = useState<ForcedCheckin | null>(null);

  const [topTab, setTopTab] = useState<"positions" | "trades">("positions");
  const [trades, setTrades] = useState<CompetitionTrade[] | null>(null);
  const [tradesError, setTradesError] = useState<string | null>(null);
  const [tradesLoading, setTradesLoading] = useState(false);
  const [sinceFilter, setSinceFilter] = useState("");
  const [untilFilter, setUntilFilter] = useState("");
  const [kindFilter, setKindFilter] = useState<CompetitorKind | "">("");
  const [cancelingTradeId, setCancelingTradeId] = useState<number | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [expandedTradeId, setExpandedTradeId] = useState<number | null>(null);

  const [refreshingScoreboard, setRefreshingScoreboard] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read inside the socket effect's "league.trade" handler without making
  // the socket itself reconnect every time the filter changes.
  const kindFilterRef = useRef(kindFilter);
  useEffect(() => {
    kindFilterRef.current = kindFilter;
  }, [kindFilter]);

  const loadCompetitionData = async (competitionId: number) => {
    const [board, list, curve] = await Promise.all([
      getScoreboard(competitionId),
      listCompetitors(competitionId),
      getEquityCurve(competitionId),
    ]);
    setScoreboard(board);
    setCompetitors(list);
    setEquityCurve(curve);
  };

  useEffect(() => {
    let cancelled = false;
    listCompetitions()
      .then(async (all) => {
        if (cancelled) return;
        const first = all[0] ?? null;
        setCompetition(first);
        if (first) await loadCompetitionData(first.id);
      })
      .catch((err) => {
        if (!cancelled) setError(extractGenericMessage(err, "Couldn't load the league."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Forced check-in slots are the same 3-daily-floor rows for every
  // competitor in a competition (finance-backend/docs/league-api.md), so the first AI
  // competitor's own next-wakeups view is enough to drive the
  // competition-wide "next forced check-in" footer stat.
  const firstAiCompetitorId = competitors.find((c) => c.kind === "ai")?.id ?? null;
  useEffect(() => {
    if (!firstAiCompetitorId) return;
    let cancelled = false;
    getNextWakeups(firstAiCompetitorId)
      .then((w) => !cancelled && setNextForcedCheckin(w.forced_checkins[0] ?? null))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [firstAiCompetitorId]);

  // The scoreboard/summary endpoints don't carry an open-positions count --
  // it only exists on each competitor's own detail -- so the "# Positions"
  // column fetches every competitor's detail in parallel rather than
  // exposing that N+1 as a per-row lazy load (the desktop table wants the
  // count up front, not just on expand). Re-runs whenever the roster
  // changes or a trade/wake-up fires (refreshSignal).
  const [positionCounts, setPositionCounts] = useState<Map<number, number>>(new Map());
  useEffect(() => {
    if (competitors.length === 0) {
      setPositionCounts(new Map());
      return;
    }
    let cancelled = false;
    Promise.all(
      competitors.map((c) =>
        getCompetitor(c.id)
          .then((d): [number, number] => [c.id, d.positions.length])
          .catch((): [number, number] => [c.id, -1]),
      ),
    ).then((pairs) => {
      if (!cancelled) setPositionCounts(new Map(pairs.filter(([, count]) => count >= 0)));
    });
    return () => {
      cancelled = true;
    };
  }, [competitors, refreshSignal]);

  // Clears one wake-up out of the "Wake up all" tracking map (terminal
  // event, or the fallback timeout below), tearing down its timer either way.
  const clearWakeup = (wakeupId: number) => {
    setPendingWakeups((prev) => {
      if (!prev.has(wakeupId)) return prev;
      const next = new Map(prev);
      next.delete(wakeupId);
      return next;
    });
    const timer = wakeupFallbackTimers.current.get(wakeupId);
    if (timer) {
      clearTimeout(timer);
      wakeupFallbackTimers.current.delete(wakeupId);
    }
  };

  // Starts tracking one wake-up triggered from "Wake up all" -- see
  // pendingWakeups' comment above for the lifecycle.
  const trackWakeup = (wakeupId: number) => {
    setPendingWakeups((prev) => {
      const next = new Map(prev);
      next.set(wakeupId, "queued");
      return next;
    });
    wakeupFallbackTimers.current.set(
      wakeupId,
      setTimeout(() => clearWakeup(wakeupId), WAKEUP_FALLBACK_MS),
    );
  };

  // Clear every outstanding fallback timer on unmount.
  useEffect(() => {
    return () => {
      wakeupFallbackTimers.current.forEach((timer) => clearTimeout(timer));
      wakeupFallbackTimers.current.clear();
    };
  }, []);

  // league.trade_activity / league.wakeup_complete / league.wakeup_failed all
  // arrive as generic notification.new pushes -- refresh the scoreboard and
  // whichever competitor's detail panel is open on any of them, and clear
  // the matching wakeup_id out of "Wake up all"'s tracking if it's one of
  // the wake-ups that button triggered.
  useEffect(() => {
    if (!competition) return;
    return realtime.on("notification.new", (message) => {
      const type = message.notification_type;
      if (typeof type !== "string" || !type.startsWith("league.")) return;
      loadCompetitionData(competition.id).catch(() => {});
      setRefreshSignal((k) => k + 1);
      const payload = message.payload as Record<string, unknown> | undefined;
      const wakeupId = payload?.wakeup_id;
      if (typeof wakeupId === "number") clearWakeup(wakeupId);
    });
  }, [competition]);

  // league.wakeup_started -- a plain push on the same /ws/user/ socket, NOT
  // wrapped in notification.new (unpersisted, so a missed one just leaves
  // that wake-up on "queued" until its terminal event or the fallback
  // timeout). Read defensively since the payload nesting isn't fully pinned
  // down -- fall back to the top-level message if `payload` isn't there.
  useEffect(() => {
    return realtime.on("league.wakeup_started", (message) => {
      const payload = ((message.payload as Record<string, unknown> | undefined) ?? message) as Record<string, unknown>;
      const wakeupId = payload.wakeup_id;
      if (typeof wakeupId !== "number") return;
      setPendingWakeups((prev) => (prev.has(wakeupId) ? new Map(prev).set(wakeupId, "thinking") : prev));
    });
  }, []);

  // Lazy: only hit the trades endpoint once the Trades tab is actually
  // opened, and again whenever a filter changes -- avoids adding a request
  // to the already-slow initial page load for a tab most visits won't use.
  useEffect(() => {
    if (!competition || topTab !== "trades") return;
    let cancelled = false;
    setTradesLoading(true);
    setTradesError(null);
    listCompetitionTrades(competition.id, {
      since: sinceFilter || undefined,
      until: untilFilter || undefined,
      competitorKind: kindFilter || undefined,
    })
      .then((rows) => !cancelled && setTrades(rows))
      .catch((err) => {
        if (!cancelled) setTradesError(extractGenericMessage(err, "Couldn't load trades."));
      })
      .finally(() => {
        if (!cancelled) setTradesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [competition, topTab, sinceFilter, untilFilter, kindFilter]);

  // One socket per competition page (finance-backend/docs/league-api.md's "Live competition
  // feed") for everything it carries: the trade feed, and the manual-refresh
  // button's league.scoreboard_refreshed reply. Live feed connects as soon
  // as the competition is known, independent of which tab is active, so
  // trades already loaded stay current even while looking at Positions.
  // league.trade only touches the list once the Trades tab has actually
  // fetched a base one (trades !== null) -- until then a live push adds
  // nothing, since opening the tab will pull it fresh from the REST call
  // above anyway. since/until aren't re-checked against a push because a
  // push always represents "now", which satisfies any realistic date range.
  // A pending order and its later resolution share the same trade id rather
  // than arriving as separate rows, so this upserts by id instead of always
  // prepending -- otherwise a pending->filled/rejected push would show up as
  // a duplicate second row still stuck on "queued".
  useEffect(() => {
    if (!competition) return;
    const socket = new LeagueFeedSocket(competition.id);

    const offTrade = socket.on("league.trade", (msg) => {
      if (kindFilterRef.current && msg.competitor_kind !== kindFilterRef.current) return;
      const trade = msg as unknown as CompetitionTrade;
      setTrades((prev) => {
        if (!prev) return prev;
        const idx = prev.findIndex((t) => t.id === trade.id);
        if (idx === -1) return [trade, ...prev];
        const next = [...prev];
        next[idx] = trade;
        return next;
      });
    });

    const offRefresh = socket.on("league.scoreboard_refreshed", (msg) => {
      setScoreboard(msg as unknown as Scoreboard);
      setRefreshingScoreboard(false);
      if (refreshTimeoutRef.current) {
        clearTimeout(refreshTimeoutRef.current);
        refreshTimeoutRef.current = null;
      }
    });

    return () => {
      offTrade();
      offRefresh();
      socket.close();
      if (refreshTimeoutRef.current) {
        clearTimeout(refreshTimeoutRef.current);
        refreshTimeoutRef.current = null;
      }
    };
  }, [competition]);

  const handleJoined = (competitor: CompetitorSummary) => {
    setCompetitors((prev) => [...prev, competitor]);
    if (competition) loadCompetitionData(competition.id).catch(() => {});
  };

  // Both outcomes (a clean cancel, or losing the race against the resolver)
  // come back as the same full Trade row -- upsert it in place either way,
  // no follow-up fetch needed (see cancelTrade()'s comment in lib/league.ts).
  const handleCancelTrade = async (competitorId: number, tradeId: number) => {
    setCancelError(null);
    setCancelingTradeId(tradeId);
    try {
      const updated = await cancelTrade(competitorId, tradeId);
      setTrades((prev) =>
        prev ? prev.map((t) => (t.id === updated.id ? { ...t, ...updated } : t)) : prev,
      );
    } catch (err) {
      setCancelError(extractGenericMessage(err, "Couldn't cancel that order."));
    } finally {
      setCancelingTradeId(null);
    }
  };

  const handleRefreshScoreboard = async () => {
    if (!competition) return;
    setRefreshError(null);
    setRefreshingScoreboard(true);
    try {
      await refreshCompetition(competition.id);
    } catch (err) {
      setRefreshingScoreboard(false);
      setRefreshError(extractGenericMessage(err, "Couldn't refresh prices."));
      return;
    }
    // league.scoreboard_refreshed normally clears this well before the
    // fallback fires -- see the socket effect above.
    if (refreshTimeoutRef.current) clearTimeout(refreshTimeoutRef.current);
    refreshTimeoutRef.current = setTimeout(() => {
      refreshTimeoutRef.current = null;
      setRefreshingScoreboard(false);
      loadCompetitionData(competition.id).catch(() => {});
    }, REFRESH_FALLBACK_MS);
  };

  const handleWakeAll = async () => {
    const targets = competitors.filter((c) => c.kind === "ai").slice(0, WAKE_ALL_MAX);
    if (targets.length === 0) return;
    const noun = targets.length === 1 ? "AI agent" : "AI agents";
    if (!window.confirm(`You are about to wake up ${targets.length} ${noun}. Do you want to do this?`)) return;
    setWakeAllSending(true);
    setWakeAllError(null);
    let failures = 0;
    for (let i = 0; i < targets.length; i++) {
      try {
        const w = await triggerWakeup(targets[i].id);
        trackWakeup(w.id);
      } catch {
        failures++;
      }
      if (i < targets.length - 1) await sleep(WAKE_ALL_DELAY_MS);
    }
    setWakeAllSending(false);
    if (failures > 0) setWakeAllError(`${failures} of ${targets.length} wake-ups failed to trigger.`);
  };

  const hasHumanCompetitor = competitors.some((c) => c.kind === "human");
  const humanCompetitor = competitors.find((c) => c.kind === "human") ?? null;
  const aiCompetitorCount = competitors.filter((c) => c.kind === "ai").length;

  const wakeAllBusy = wakeAllSending || pendingWakeups.size > 0;
  const wakeAllThinkingCount = [...pendingWakeups.values()].filter((phase) => phase === "thinking").length;
  const wakeAllLabel = !wakeAllBusy
    ? "Wake up all"
    : wakeAllThinkingCount > 0
      ? `Thinking… (${wakeAllThinkingCount}/${pendingWakeups.size})`
      : pendingWakeups.size > 0
        ? `Queued… (${pendingWakeups.size})`
        : "Queued…";

  // Fetched fresh each time the header's New trade button opens the modal
  // (rather than kept in sync continuously) -- it's just there to seed the
  // quick-select position badges, same as everywhere else TradeModal is used.
  const [newTradeOpen, setNewTradeOpen] = useState(false);
  const [newTradePositions, setNewTradePositions] = useState<Position[]>([]);

  const openNewTrade = () => {
    if (!humanCompetitor) return;
    setNewTradeOpen(true);
    getCompetitor(humanCompetitor.id)
      .then((d) => setNewTradePositions(d.positions))
      .catch(() => {});
  };

  const startingCapital = competition ? Number(competition.starting_capital) : 0;
  const dayInfo = competition ? computeDayInfo(competition.start_date, competition.end_date) : null;

  const colorById = useMemo(() => {
    const map = new Map<number, string>();
    for (const c of competitors) if (c.color) map.set(c.id, c.color);
    return map;
  }, [competitors]);

  const chartSeries = useMemo(
    () => (scoreboard ? buildChartSeries(scoreboard.competitors, equityCurve, startingCapital, colorById) : []),
    [scoreboard, equityCurve, startingCapital, colorById],
  );

  const curveById = useMemo(() => {
    const map = new Map<number, EquityCurveSeries>();
    for (const s of equityCurve ?? []) map.set(s.competitor_id, s);
    return map;
  }, [equityCurve]);

  const chartRangeLabel = useMemo(() => {
    const times = (equityCurve ?? [])
      .flatMap((s) => s.points.map((p) => new Date(p.at).getTime()))
      .filter((t) => !Number.isNaN(t));
    if (times.length === 0) return null;
    const fmt = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `${fmt(Math.min(...times))} – ${fmt(Math.max(...times))}`;
  }, [equityCurve]);

  const leaderRow = scoreboard?.competitors[0] ?? null;
  const leaderSummary = leaderRow ? competitors.find((c) => c.id === leaderRow.id) : undefined;
  const leaderModel = leaderSummary?.assistant_model;
  const secondRow = scoreboard?.competitors[1] ?? null;
  const leadOverSecondPts =
    leaderRow && secondRow ? (Number(leaderRow.total_return_pct) - Number(secondRow.total_return_pct)) * 100 : null;

  const totalValue = scoreboard ? scoreboard.competitors.reduce((sum, c) => sum + Number(c.account_value), 0) : 0;
  const deployed = competitors.length * startingCapital;
  const totalFilledTrades = scoreboard ? scoreboard.competitors.reduce((sum, c) => sum + c.filled_trades_count, 0) : 0;
  const totalApiCost = scoreboard ? scoreboard.competitors.reduce((sum, c) => sum + Number(c.api_cost_usd ?? 0), 0) : 0;
  const totalReturnPoints = scoreboard
    ? scoreboard.competitors.reduce((sum, c) => sum + Number(c.total_return_pct) * 100, 0)
    : 0;
  const costPerPoint = totalReturnPoints !== 0 ? totalApiCost / totalReturnPoints : null;
  const topRejection = scoreboard?.rejected_trades[0] ?? null;

  return (
    <div className="page">
      {competition && dayInfo && (
        <div className="league-topline">
          <span className="league-day-badge">
            Day {dayInfo.dayNum} of {dayInfo.totalDays}
          </span>
          <span className="text-muted league-topline-dates">{formatDateRange(competition.start_date, competition.end_date)}</span>
        </div>
      )}

      <div className="page-head">
        <h2>Paper Trading League</h2>
        {competition && (
          <div className="league-header-actions">
            {humanCompetitor && (
              <button type="button" className="btn btn-secondary" onClick={openNewTrade}>
                {isMobile ? "Trade" : "New trade"}
              </button>
            )}
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleRefreshScoreboard}
              disabled={refreshingScoreboard}
              title="Force a live re-quote of every open position, right now"
            >
              {isMobile && (
                <svg
                  className="league-header-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M23 4v6h-6" />
                  <path d="M1 20v-6h6" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
              )}
              {isMobile ? (refreshingScoreboard ? "…" : "Prices") : refreshingScoreboard ? "Refreshing…" : "Refresh prices"}
            </button>
            <button
              type="button"
              className={`btn btn-secondary${isMobile ? " btn-icon-sm" : ""}`}
              onClick={handleWakeAll}
              disabled={wakeAllBusy || aiCompetitorCount === 0}
              title={wakeAllBusy ? wakeAllLabel : `Wakes up to ${WAKE_ALL_MAX} AI competitors, ${WAKE_ALL_DELAY_MS / 1000}s apart`}
              aria-label="Wake up all"
            >
              {isMobile ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z" />
                </svg>
              ) : (
                wakeAllLabel
              )}
            </button>
            <button
              type="button"
              className={`btn btn-primary${isMobile ? " btn-icon-sm" : ""}`}
              onClick={() => setAddModalOpen(true)}
              aria-label="Add competitor"
              title={isMobile ? "Add competitor" : undefined}
            >
              {isMobile ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              ) : (
                "Add competitor"
              )}
            </button>
          </div>
        )}
      </div>

      {refreshError && <p className="form-error">{refreshError}</p>}

      {wakeAllError && <p className="form-error">{wakeAllError}</p>}

      {loading && <p className="text-muted">Loading league…</p>}
      {error && <p className="form-error">{error}</p>}

      {!loading && !error && !competition && <p className="text-muted">No competition has been created yet.</p>}

      {competition && (
        <>
          <p className="text-muted">
            {competitors.length} operator{competitors.length === 1 ? "" : "s"}, one mandate each, {formatUsd(startingCapital)} of
            simulated capital. Every trade carries a written thesis. Nothing here is real money.
          </p>

          {scoreboard && leaderRow && (
            <div className="league-hero-grid">
              <div className="league-hero-card">
                <div className="league-hero-tags">
                  <span className="tag tag-outline league-hero-leader-tag">Leader · Rank 01</span>
                </div>
                <h3 className="league-hero-name">
                  <CompetitorAvatar color={leaderSummary?.color} avatar={leaderSummary?.avatar} size={28} /> {leaderRow.name}
                </h3>
                {leaderModel && <p className="league-hero-sub">{leaderModel}</p>}
                <div className="league-hero-stats">
                  <div>
                    <div className="card-kicker">Total return</div>
                    <div className="league-hero-figure">{formatSignedPercent(Number(leaderRow.total_return_pct))}</div>
                  </div>
                  <div>
                    <div className="card-kicker">Account value</div>
                    <div className="league-hero-figure-sm">{formatUsd(Number(leaderRow.account_value))}</div>
                  </div>
                  {leadOverSecondPts !== null && (
                    <div>
                      <div className="card-kicker">Lead over 2nd</div>
                      <div className="league-hero-figure-sm">
                        {leadOverSecondPts > 0 ? "+" : ""}
                        {leadOverSecondPts.toFixed(1)} pts
                      </div>
                    </div>
                  )}
                </div>
              </div>
              <div className="card elev-sm league-hero-chart-card">
                <div className="page-head" style={{ marginBottom: 0 }}>
                  <span className="card-kicker">Equity curves</span>
                  {chartRangeLabel && (
                    <span className="text-muted" style={{ marginLeft: "auto", fontSize: 12 }}>
                      {chartRangeLabel}
                    </span>
                  )}
                </div>
                <EquityChart series={chartSeries} baseline={startingCapital} />
              </div>
            </div>
          )}

          {scoreboard && (
            <div className="stat-strip league-stats-strip">
              <div className="stat-strip-item">
                <div className="card-kicker">League total value</div>
                <div className="card-title">{formatUsd(totalValue)}</div>
                <div className="card-meta">vs {formatUsd(deployed)} deployed</div>
              </div>
              <div className="stat-strip-item">
                <div className="card-kicker">Trades filled</div>
                <div className="card-title">{totalFilledTrades}</div>
                <div className="card-meta">
                  {topRejection ? `${topRejection.count} rejected on ${rejectionLabel(topRejection.reason)}` : "No trades rejected"}
                </div>
              </div>
              <div className="stat-strip-item">
                <div className="card-kicker">Spent on thinking</div>
                <div className="card-title">{formatUsd(totalApiCost)}</div>
                <div className="card-meta">{costPerPoint !== null ? `${formatUsd(costPerPoint)} per point of return` : "—"}</div>
              </div>
              <div className="stat-strip-item">
                <div className="card-kicker">Next forced check-in</div>
                <div className="card-title">{nextForcedCheckin ? formatTime(nextForcedCheckin.next_run_at) : "—"}</div>
                <div className="card-meta">{nextForcedCheckin ? nextForcedCheckin.label : "no AI competitors yet"}</div>
              </div>
            </div>
          )}

          <div className="seg" role="tablist" aria-label="League view">
            <label className="seg-opt">
              <input type="radio" name="league-top-tab" checked={topTab === "positions"} onChange={() => setTopTab("positions")} />
              Positions
            </label>
            <label className="seg-opt">
              <input type="radio" name="league-top-tab" checked={topTab === "trades"} onChange={() => setTopTab("trades")} />
              Trades
            </label>
          </div>

          {topTab === "positions" && scoreboard && isMobile && (
            <div className="league-mobile-list">
              {scoreboard.competitors.map((c) => {
                const summary = competitors.find((comp) => comp.id === c.id) ?? null;
                const expanded = c.id === selectedId;
                return (
                  <div className="league-mobile-item" key={c.id}>
                    <div
                      className="league-mobile-row"
                      onClick={() => setSelectedId((prev) => (prev === c.id ? null : c.id))}
                      style={{ cursor: "pointer" }}
                    >
                      <svg
                        className={`league-mobile-chevron${expanded ? " is-open" : ""}`}
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                      <span className="league-mobile-name">
                        <CompetitorAvatar color={summary?.color} avatar={summary?.avatar} size={20} />
                        {c.name}
                      </span>
                      <span className="league-mobile-value">{formatUsd(Number(c.account_value))}</span>
                      <Link
                        to={`/league/competitors/${c.id}`}
                        className="btn btn-secondary btn-icon-sm league-mobile-goto"
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`Open ${c.name}'s dashboard`}
                        title="Open competitor dashboard"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M9 6l6 6-6 6" />
                        </svg>
                      </Link>
                    </div>
                    {expanded && (
                      <div className="league-mobile-expand">
                        <PositionsOnlyPanel competitorId={c.id} refreshSignal={refreshSignal} compact />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {topTab === "positions" && scoreboard && !isMobile && (
            <div className="table-wrap table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Competitor</th>
                    <th>Curve</th>
                    <th>Account</th>
                    <th>Return</th>
                    <th># Positions</th>
                    <th>Trades</th>
                    <th>API cost</th>
                    <th>Last woke</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {scoreboard.competitors.map((c, i) => {
                    const summary = competitors.find((comp) => comp.id === c.id) ?? null;
                    const rank = i + 1;
                    const rowClasses = [
                      c.id === selectedId ? "league-row-active" : "",
                      rank === 1 ? "league-leader-row" : "",
                      c.kind === "human" ? "league-you-row" : "",
                    ]
                      .filter(Boolean)
                      .join(" ");
                    return (
                      <Fragment key={c.id}>
                        <tr
                          onClick={() => setSelectedId((prev) => (prev === c.id ? null : c.id))}
                          className={rowClasses || undefined}
                          style={{ cursor: "pointer" }}
                        >
                          <td data-label="#">{String(rank).padStart(2, "0")}</td>
                          <td data-label="Competitor">
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                              <CompetitorAvatar color={summary?.color} avatar={summary?.avatar} size={20} />
                              {c.name}
                            </span>{" "}
                            <span className={`tag ${c.kind === "ai" ? "tag-outline" : "tag-accent"}`}>{c.kind === "ai" ? "AI" : "YOU"}</span>
                          </td>
                          <td data-label="Curve">
                            <Sparkline
                              points={(curveById.get(c.id)?.points ?? []).map((p) => ({ at: p.at, value: Number(p.account_value) }))}
                              color={summary?.color ? competitorColor(summary.color) : rank === 1 ? LEADER_COLOR : NOTABLE_COLOR}
                            />
                          </td>
                          <td data-label="Account">{formatUsd(Number(c.account_value))}</td>
                          <td data-label="Return">{formatSignedPercent(Number(c.total_return_pct))}</td>
                          <td data-label="# Positions">{positionCounts.get(c.id) ?? "—"}</td>
                          <td data-label="Trades">{c.filled_trades_count}</td>
                          <td data-label="API cost">{c.api_cost_usd !== null ? formatUsd(Number(c.api_cost_usd)) : "—"}</td>
                          <td data-label="Last woke" title={c.last_woke_at ? formatDateTime(c.last_woke_at) : undefined}>
                            {c.last_woke_at ? formatLastWoke(c.last_woke_at) : "never"}
                          </td>
                          <td data-label="Actions" onClick={(e) => e.stopPropagation()}>
                            <Link to={`/league/competitors/${c.id}`} className="btn btn-secondary">
                              Dashboard
                            </Link>
                          </td>
                        </tr>
                        {c.id === selectedId && summary && (
                          <tr>
                            <td colSpan={10} className="league-expanded-cell">
                              <PositionsOnlyPanel competitorId={c.id} refreshSignal={refreshSignal} compact={false} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {topTab === "trades" && (
            <div className="stack">
              <div className="screener-search">
                <div className="field">
                  <label htmlFor="trades-since">Since</label>
                  <input
                    id="trades-since"
                    type="date"
                    className="input"
                    value={sinceFilter}
                    onChange={(e) => setSinceFilter(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="trades-until">Until</label>
                  <input
                    id="trades-until"
                    type="date"
                    className="input"
                    value={untilFilter}
                    onChange={(e) => setUntilFilter(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="trades-kind">Competitor</label>
                  <select
                    id="trades-kind"
                    className="input"
                    value={kindFilter}
                    onChange={(e) => setKindFilter(e.target.value as CompetitorKind | "")}
                  >
                    <option value="">All</option>
                    <option value="ai">AI</option>
                    <option value="human">Human</option>
                  </select>
                </div>
              </div>

              {tradesError && <p className="form-error">{tradesError}</p>}
              {tradesLoading && !trades && <p className="text-muted">Loading trades…</p>}
              {trades && trades.length === 0 && <p className="text-muted">No trades in this range.</p>}

              {trades && trades.length > 0 && (
                <div className="league-mobile-list">
                  {trades.map((t) => {
                    const expanded = t.id === expandedTradeId;
                    const strikeLabel = t.strike ? Number(t.strike).toFixed(2) : t.strike;
                    const label = `${t.ticker}${t.instrument_type !== "stock" ? ` ${t.instrument_type} ${strikeLabel}` : ""}`;
                    const orderTotal = tradeOrderTotal(t);
                    return (
                      <div className="league-mobile-item" key={t.id}>
                        <div
                          className="league-mobile-row"
                          onClick={() => setExpandedTradeId((prev) => (prev === t.id ? null : t.id))}
                          style={{ cursor: "pointer" }}
                        >
                          <svg
                            className={`league-mobile-chevron${expanded ? " is-open" : ""}`}
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M6 9l6 6 6-6" />
                          </svg>
                          <span className="league-mobile-name">
                            {isMobile ? truncateLabel(label, 15) : label}
                            {!isMobile && (
                              <span className="league-mobile-trade-competitor">
                                {t.competitor_name} · {t.competitor_kind === "ai" ? "AI" : "YOU"}
                              </span>
                            )}
                          </span>
                          <span className="league-mobile-trade-price">
                            {isMobile
                              ? orderTotal !== null
                                ? formatUsdExact(orderTotal)
                                : "—"
                              : t.fill_price
                                ? formatPrice(Number(t.fill_price))
                                : "—"}
                          </span>
                          {!isMobile && (
                            <span className="league-mobile-trade-meta">
                              Qty {t.quantity} · Total {orderTotal !== null ? formatUsdExact(orderTotal) : "—"}
                            </span>
                          )}
                          {!isMobile && (
                            <span className="league-mobile-trade-meta">{formatShortDateTime(t.created_at)}</span>
                          )}
                          <span className={`tag ${tradeStatusTagClass(t.status)} league-mobile-value`}>
                            {t.side.replace(/_/g, " ").toUpperCase()}
                          </span>
                        </div>
                        {expanded && (
                          <div className="league-mobile-expand">
                            <ul className="league-mobile-positions">
                              <li className="league-mobile-position-row">
                                <span className="league-mobile-position-ticker">When</span>
                                <span className="league-mobile-position-value">{formatDateTime(t.created_at)}</span>
                              </li>
                              {isMobile && (
                                <li className="league-mobile-position-row">
                                  <span className="league-mobile-position-ticker">Competitor</span>
                                  <span className="league-mobile-position-value">
                                    {t.competitor_name}{" "}
                                    <span className={`tag ${t.competitor_kind === "ai" ? "tag-outline" : "tag-accent"}`}>
                                      {t.competitor_kind === "ai" ? "AI" : "YOU"}
                                    </span>
                                  </span>
                                </li>
                              )}
                              <li className="league-mobile-position-row">
                                <span className="league-mobile-position-ticker">Qty</span>
                                <span className="league-mobile-position-value">{t.quantity}</span>
                              </li>
                            </ul>
                            {t.status === "rejected" && <p className="card-meta">{t.rejection_reason}</p>}
                            {t.status === "pending" && (
                              <div className="league-mobile-pending-actions">
                                <span className="text-muted">Fills at next open</span>
                                {t.competitor_kind === "human" && (
                                  <button
                                    type="button"
                                    className="btn btn-secondary"
                                    onClick={() => handleCancelTrade(t.competitor_id, t.id)}
                                    disabled={cancelingTradeId === t.id}
                                  >
                                    {cancelingTradeId === t.id ? "Cancelling…" : "Cancel"}
                                  </button>
                                )}
                              </div>
                            )}
                            <div className="card-kicker" style={{ marginTop: 8 }}>
                              Thesis
                            </div>
                            <p className="card-body">{t.thesis}</p>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {cancelError && <p className="form-error">{cancelError}</p>}
            </div>
          )}

          {addModalOpen && (
            <AddCompetitorModal
              competitionId={competition.id}
              hasHumanCompetitor={hasHumanCompetitor}
              onClose={() => setAddModalOpen(false)}
              onJoined={(c) => {
                handleJoined(c);
                setAddModalOpen(false);
              }}
            />
          )}

          {newTradeOpen && humanCompetitor && (
            <TradeModal
              competitorId={humanCompetitor.id}
              positions={newTradePositions}
              onClose={() => setNewTradeOpen(false)}
              onFilled={(trade) => {
                setNewTradeOpen(false);
                setTrades((prev) =>
                  prev
                    ? [
                        { ...trade, competitor_id: humanCompetitor.id, competitor_name: humanCompetitor.name, competitor_kind: humanCompetitor.kind },
                        ...prev,
                      ]
                    : prev,
                );
                setRefreshSignal((k) => k + 1);
                loadCompetitionData(competition.id).catch(() => {});
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

// Expanding any competitor's row (mobile or desktop) shows just their open
// positions -- no trades/reasoning tabs, no system prompt, no budget bars,
// no wake button. A human competitor's own trading (New Trade, Sell,
// Buy-to-close, cancel a pending order) now lives only on their full
// competitor dashboard page (the small icon/Dashboard link on each row),
// not inline in this scoreboard.
//
// `compact` picks the layout: mobile's collapsible list has no room for
// more than a ticker + value per row, but desktop has the width for the
// same full open-positions table CompetitorDashboardPage uses (Ticker,
// Instrument, Qty, Avg cost, Mark, Unrealized, Target/dead), minus the
// Sell/Buy-to-close Actions column -- this view is read-only.
function PositionsOnlyPanel({
  competitorId,
  refreshSignal,
  compact,
}: {
  competitorId: number;
  refreshSignal: number;
  compact: boolean;
}) {
  const [detail, setDetail] = useState<CompetitorDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    getCompetitor(competitorId)
      .then((d) => !cancelled && setDetail(d))
      .catch((err) => !cancelled && setError(extractGenericMessage(err, "Couldn't load positions.")));
    return () => {
      cancelled = true;
    };
  }, [competitorId, refreshSignal]);

  if (error) return <p className="form-error">{error}</p>;
  if (!detail) return <p className="text-muted">Loading…</p>;

  if (compact) {
    if (detail.positions.length === 0) return <p className="text-muted">No open positions.</p>;
    return (
      <ul className="league-mobile-positions league-positions-only">
        {detail.positions.map((p, i) => {
          const pnl = positionPnl(p);
          return (
            <li className="league-mobile-position-row" key={i}>
              <span className="league-mobile-position-ticker">
                {p.ticker}
                {p.instrument_type !== "stock" && (
                  <span className="text-muted"> {p.instrument_type} ${p.strike}</span>
                )}
              </span>
              <span className={`league-mobile-position-value ${pnlClass(pnl)}`}>{formatUsd(Number(p.current_value))}</span>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="table-wrap table-scroll">
      <table className="table">
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Instrument</th>
            <th>Qty</th>
            <th>Avg cost</th>
            <th>Mark</th>
            <th>Unrealized</th>
            <th>Target / dead</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td data-label="Ticker">SPAXX</td>
            <td data-label="Instrument" className="text-muted">
              Cash
            </td>
            <td data-label="Qty">—</td>
            <td data-label="Avg cost">—</td>
            <td data-label="Mark">—</td>
            <td data-label="Unrealized">{formatUsd(Number(detail.cash_balance))}</td>
            <td data-label="Target / dead"></td>
          </tr>
          {detail.positions.map((p, i) => {
            const pnl = positionPnl(p);
            return (
              <tr key={i}>
                <td data-label="Ticker">
                  <strong>{p.ticker}</strong>
                </td>
                <td data-label="Instrument">
                  {p.instrument_type}
                  {p.strike && ` $${p.strike} exp ${formatShortDate(p.expiration)}`}
                  {p.is_short && <span className="tag tag-outline">SHORT LEG</span>}
                </td>
                <td data-label="Qty">{p.quantity}</td>
                <td data-label="Avg cost">{formatPrice(Number(p.avg_cost))}</td>
                <td
                  data-label="Mark"
                  className={pnlClass(pnl)}
                  title={p.priced_at ? `priced ${formatDateTime(p.priced_at)}` : "no live quote yet -- priced at cost"}
                >
                  {formatPrice(Number(p.current_price))}
                </td>
                <td data-label="Unrealized" className={pnlClass(pnl)}>
                  {formatSignedUsd(pnl)}
                </td>
                <td data-label="Target / dead" className="text-muted">
                  {p.target_price ? formatPrice(Number(p.target_price)) : "—"} /{" "}
                  {p.dead_price ? formatPrice(Number(p.dead_price)) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {detail.positions.length === 0 && <p className="text-muted">No open positions.</p>}
    </div>
  );
}
