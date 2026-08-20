// Medium-Term Paper Trading League (docs/paper-trading-league-rules.md,
// docs/league-api.md): George vs. Claude, backend-enforced rules engine.
// Only one competition is seeded today, so this page skips a competition
// picker and just loads the first one -- add a picker later if a second
// competition ever gets created.

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { realtime, LeagueFeedSocket } from "../lib/ws";
import { extractGenericMessage } from "../lib/formErrors";
import {
  formatDateTime,
  formatPrice,
  formatSignedPercent,
  formatSignedUsd,
  formatTime,
  formatUsd,
} from "../lib/format";
import { Markdown } from "../components/Markdown";
import { TradeModal } from "../components/TradeModal";
import { TurnTranscriptModal } from "../components/TurnTranscriptModal";
import { AddCompetitorModal } from "../components/AddCompetitorModal";
import { CompetitorAvatar } from "../components/CompetitorAvatar";
import { EquityChart, type EquityChartSeries } from "../components/EquityChart";
import { Sparkline } from "../components/Sparkline";
import {
  competitorColor,
  getCompetitor,
  getEquityCurve,
  getNextWakeups,
  getScoreboard,
  getScratchpad,
  listCompetitions,
  listCompetitionTrades,
  listCompetitors,
  listModels,
  listTrades,
  listTurns,
  pnlClass,
  positionPnl,
  refreshCompetition,
  triggerWakeup,
  REJECTION_CODE_LABELS,
  TURN_TRIGGER_LABELS,
  type Competition,
  type CompetitionTrade,
  type CompetitorDetail,
  type CompetitorKind,
  type CompetitorSummary,
  type EquityCurveSeries,
  type ForcedCheckin,
  type LeagueModel,
  type NextWakeups,
  type Scoreboard,
  type Scratchpad,
  type Trade,
  type TurnSummary,
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
// forever (docs/league-api.md's "Building the manual-refresh button").
const REFRESH_FALLBACK_MS = 15_000;

const WAKE_ALL_MAX = 10;
const WAKE_ALL_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function LeaguePage() {
  const [competition, setCompetition] = useState<Competition | null>(null);
  const [scoreboard, setScoreboard] = useState<Scoreboard | null>(null);
  const [competitors, setCompetitors] = useState<CompetitorSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [wakingAll, setWakingAll] = useState(false);
  const [wakeAllError, setWakeAllError] = useState<string | null>(null);
  const [models, setModels] = useState<LeagueModel[]>([]);
  const [equityCurve, setEquityCurve] = useState<EquityCurveSeries[] | null>(null);
  const [nextForcedCheckin, setNextForcedCheckin] = useState<ForcedCheckin | null>(null);

  const [topTab, setTopTab] = useState<"positions" | "trades">("positions");
  const [trades, setTrades] = useState<CompetitionTrade[] | null>(null);
  const [tradesError, setTradesError] = useState<string | null>(null);
  const [tradesLoading, setTradesLoading] = useState(false);
  const [sinceFilter, setSinceFilter] = useState("");
  const [untilFilter, setUntilFilter] = useState("");
  const [kindFilter, setKindFilter] = useState<CompetitorKind | "">("");

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

  useEffect(() => {
    listModels()
      .then(setModels)
      .catch(() => {});
  }, []);

  // Forced check-in slots are the same 3-daily-floor rows for every
  // competitor in a competition (docs/league-api.md), so the first AI
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

  // league.trade_activity / league.wakeup_complete / league.wakeup_failed all
  // arrive as generic notification.new pushes -- refresh the scoreboard and
  // whichever competitor's detail panel is open on any of them.
  useEffect(() => {
    if (!competition) return;
    return realtime.on("notification.new", (message) => {
      const type = message.notification_type;
      if (typeof type !== "string" || !type.startsWith("league.")) return;
      loadCompetitionData(competition.id).catch(() => {});
      setRefreshSignal((k) => k + 1);
    });
  }, [competition]);

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

  // One socket per competition page (docs/league-api.md's "Live competition
  // feed") for everything it carries: the trade feed, and the manual-refresh
  // button's league.scoreboard_refreshed reply. Live feed connects as soon
  // as the competition is known, independent of which tab is active, so
  // trades already loaded stay current even while looking at Positions.
  // league.trade only prepends once the Trades tab has actually fetched a
  // base list (trades !== null) -- until then a live push adds nothing,
  // since opening the tab will pull it fresh from the REST call above
  // anyway. since/until aren't re-checked against a push because a push
  // always represents "now", which satisfies any realistic date range.
  useEffect(() => {
    if (!competition) return;
    const socket = new LeagueFeedSocket(competition.id);

    const offTrade = socket.on("league.trade", (msg) => {
      if (kindFilterRef.current && msg.competitor_kind !== kindFilterRef.current) return;
      setTrades((prev) => (prev ? [msg as unknown as CompetitionTrade, ...prev] : prev));
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
    setWakingAll(true);
    setWakeAllError(null);
    let failures = 0;
    for (let i = 0; i < targets.length; i++) {
      try {
        await triggerWakeup(targets[i].id);
      } catch {
        failures++;
      }
      if (i < targets.length - 1) await sleep(WAKE_ALL_DELAY_MS);
    }
    setWakingAll(false);
    if (failures > 0) setWakeAllError(`${failures} of ${targets.length} wake-ups failed to trigger.`);
  };

  const hasHumanCompetitor = competitors.some((c) => c.kind === "human");
  const aiCompetitorCount = competitors.filter((c) => c.kind === "ai").length;

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
          <>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ marginLeft: "auto" }}
              onClick={handleRefreshScoreboard}
              disabled={refreshingScoreboard}
              title="Force a live re-quote of every open position, right now"
            >
              {refreshingScoreboard ? "Refreshing…" : "Refresh prices"}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleWakeAll}
              disabled={wakingAll || aiCompetitorCount === 0}
              title={`Wakes up to ${WAKE_ALL_MAX} AI competitors, ${WAKE_ALL_DELAY_MS / 1000}s apart`}
            >
              {wakingAll ? "Waking…" : "Wake up all"}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setAddModalOpen(true)}>
              Add competitor
            </button>
          </>
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

          {topTab === "positions" && scoreboard && (
            <div className="table-wrap stack-mobile">
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Competitor</th>
                    <th>Curve</th>
                    <th>Account</th>
                    <th>Return</th>
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
                          <td data-label="Trades">{c.filled_trades_count}</td>
                          <td data-label="API cost">{c.api_cost_usd !== null ? formatUsd(Number(c.api_cost_usd)) : "—"}</td>
                          <td data-label="Last woke">{c.last_woke_at ? formatTime(c.last_woke_at) : "never"}</td>
                          <td data-label="Actions" onClick={(e) => e.stopPropagation()}>
                            <Link to={`/league/competitors/${c.id}`} className="btn btn-secondary">
                              Dashboard
                            </Link>
                          </td>
                        </tr>
                        {c.id === selectedId && summary && (
                          <tr>
                            <td colSpan={9} className="league-expanded-cell">
                              <CompetitorPanel
                                summary={summary}
                                models={models}
                                refreshSignal={refreshSignal}
                                onTradeFilled={() => competition && loadCompetitionData(competition.id).catch(() => {})}
                                onCollapse={() => setSelectedId(null)}
                              />
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
                <div className="table-wrap stack-mobile">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Competitor</th>
                        <th>Side</th>
                        <th>Ticker</th>
                        <th>Qty</th>
                        <th>Fill</th>
                        <th>Status</th>
                        <th>Thesis</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trades.map((t) => (
                        <tr key={t.id}>
                          <td data-label="When">{formatDateTime(t.created_at)}</td>
                          <td data-label="Competitor">
                            {t.competitor_name}{" "}
                            <span className={`tag ${t.competitor_kind === "ai" ? "tag-outline" : "tag-accent"}`}>
                              {t.competitor_kind === "ai" ? "AI" : "YOU"}
                            </span>
                          </td>
                          <td data-label="Side">{t.side}</td>
                          <td data-label="Ticker">
                            {t.ticker} {t.instrument_type !== "stock" && `${t.instrument_type} $${t.strike}`}
                          </td>
                          <td data-label="Qty">{t.quantity}</td>
                          <td data-label="Fill">{t.fill_price ? formatPrice(Number(t.fill_price)) : "—"}</td>
                          <td data-label="Status">
                            <span className={`tag ${t.status === "filled" ? "tag-accent" : "tag-neutral"}`}>{t.status}</span>
                            {t.status === "rejected" && <div className="card-meta">{t.rejection_reason}</div>}
                          </td>
                          <td data-label="Thesis">{t.thesis}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
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
        </>
      )}
    </div>
  );
}

const TABS = ["positions", "trades", "reasoning"] as const;
type Tab = (typeof TABS)[number];

function CompetitorPanel({
  summary,
  models,
  refreshSignal,
  onTradeFilled,
  onCollapse,
}: {
  summary: CompetitorSummary;
  models: LeagueModel[];
  refreshSignal: number;
  onTradeFilled: () => void;
  onCollapse: () => void;
}) {
  const provider = models.find((m) => m.model_id === summary.assistant_model)?.provider ?? "anthropic";
  const [tab, setTab] = useState<Tab>("positions");
  const [detail, setDetail] = useState<CompetitorDetail | null>(null);
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [scratchpad, setScratchpad] = useState<Scratchpad | null>(null);
  const [turns, setTurns] = useState<TurnSummary[] | null>(null);
  const [nextWakeups, setNextWakeups] = useState<NextWakeups | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [tradeModalOpen, setTradeModalOpen] = useState(false);
  const [openTurnId, setOpenTurnId] = useState<number | null>(null);
  const [waking, setWaking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    const loads: Promise<unknown>[] = [
      getCompetitor(summary.id).then((d) => !cancelled && setDetail(d)),
      listTrades(summary.id).then((t) => !cancelled && setTrades(t)),
    ];
    if (summary.kind === "ai") {
      loads.push(getScratchpad(summary.id).then((s) => !cancelled && setScratchpad(s)));
      loads.push(listTurns(summary.id).then((t) => !cancelled && setTurns(t)));
      loads.push(getNextWakeups(summary.id).then((w) => !cancelled && setNextWakeups(w)));
    }
    Promise.all(loads).catch((err) => {
      if (!cancelled) setError(extractGenericMessage(err, "Couldn't load competitor detail."));
    });
    return () => {
      cancelled = true;
    };
  }, [summary.id, summary.kind, refreshSignal]);

  const handleWakeUp = async () => {
    setWaking(true);
    try {
      await triggerWakeup(summary.id);
    } catch (err) {
      setError(extractGenericMessage(err, "Couldn't trigger a wake-up."));
    } finally {
      setWaking(false);
    }
  };

  return (
    <div className="card elev-sm stack">
      <div className="page-head">
        <h3 style={{ display: "flex", alignItems: "center", gap: 8, margin: 0 }}>
          <CompetitorAvatar color={summary.color} avatar={summary.avatar} size={24} />
          {summary.name}
        </h3>
        {summary.assistant_model && <span className="tag tag-neutral">{summary.assistant_model}</span>}
        {summary.kind === "human" && (
          <button type="button" className="btn btn-primary" onClick={() => setTradeModalOpen(true)}>
            New trade
          </button>
        )}
        {summary.kind === "ai" && (
          <button type="button" className="btn btn-secondary" onClick={handleWakeUp} disabled={waking}>
            {waking ? "Waking…" : "Wake up now"}
          </button>
        )}
        <button type="button" className="btn btn-secondary" style={{ marginLeft: "auto" }} onClick={onCollapse}>
          Collapse
        </button>
      </div>

      {summary.kind === "ai" && nextWakeups && (nextWakeups.forced_checkins.length > 0 || nextWakeups.self_scheduled.length > 0) && (
        <div className="page-head">
          {nextWakeups.forced_checkins.map((c, i) => (
            <span className="tag tag-neutral" key={`forced-${i}`} title="Forced check-in">
              {c.label} · {formatDateTime(c.next_run_at)}
            </span>
          ))}
          {nextWakeups.self_scheduled.map((w) => (
            <span className="tag tag-accent" key={`self-${w.id}`} title={w.reason}>
              Self-scheduled · {formatDateTime(w.run_at)}
            </span>
          ))}
        </div>
      )}

      {summary.system_prompt && <p className="card-body">{summary.system_prompt}</p>}

      {error && <p className="form-error">{error}</p>}

      <div className="seg" role="tablist" aria-label="Competitor detail">
        <label className="seg-opt">
          <input type="radio" name="league-tab" checked={tab === "positions"} onChange={() => setTab("positions")} />
          Positions
        </label>
        <label className="seg-opt">
          <input type="radio" name="league-tab" checked={tab === "trades"} onChange={() => setTab("trades")} />
          Trades
        </label>
        {summary.kind === "ai" && (
          <label className="seg-opt">
            <input type="radio" name="league-tab" checked={tab === "reasoning"} onChange={() => setTab("reasoning")} />
            Reasoning
          </label>
        )}
      </div>

      {tab === "positions" && (
        <div className="table-wrap stack-mobile">
          {!detail && <p className="text-muted">Loading…</p>}
          {detail && detail.positions.length === 0 && <p className="text-muted">No open positions.</p>}
          {detail && (
            <table className="table">
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th>Value</th>
                  <th>P/L</th>
                  <th>Instrument</th>
                  <th>Qty</th>
                  <th>Current price</th>
                  <th>Avg cost</th>
                  <th>Opened</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td data-label="Ticker">SPAXX (CASH)</td>
                  <td data-label="Value">{formatUsd(Number(detail.cash_balance))}</td>
                  <td></td>
                  <td colSpan={4} className="text-muted">
                    Cash
                  </td>
                  <td></td>
                </tr>
                {detail.positions.map((p, i) => {
                  const pnl = positionPnl(p);
                  return (
                    <tr key={i}>
                      <td data-label="Ticker">{p.ticker}</td>
                      <td data-label="Value">{formatUsd(Number(p.current_value))}</td>
                      <td data-label="P/L" className={pnlClass(pnl)}>
                        {formatSignedUsd(pnl)}
                      </td>
                      <td data-label="Instrument">
                        {p.instrument_type}
                        {p.strike && ` $${p.strike} exp ${p.expiration}`}
                        {p.is_short && <span className="tag tag-outline">SHORT LEG</span>}
                      </td>
                      <td data-label="Qty">{p.quantity}</td>
                      <td data-label="Current price" className={pnlClass(pnl)}>
                        {formatPrice(Number(p.current_price))}
                      </td>
                      <td data-label="Avg cost">{formatPrice(Number(p.avg_cost))}</td>
                      <td data-label="Opened">{formatDateTime(p.opened_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === "trades" && (
        <div className="table-wrap stack-mobile">
          {!trades && <p className="text-muted">Loading…</p>}
          {trades && trades.length === 0 && <p className="text-muted">No trades yet.</p>}
          {trades && trades.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Side</th>
                  <th>Ticker</th>
                  <th>Qty</th>
                  <th>Fill</th>
                  <th>Status</th>
                  <th>Thesis</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t.id}>
                    <td data-label="When">{formatDateTime(t.created_at)}</td>
                    <td data-label="Side">{t.side}</td>
                    <td data-label="Ticker">
                      {t.ticker} {t.instrument_type !== "stock" && `${t.instrument_type} $${t.strike}`}
                    </td>
                    <td data-label="Qty">{t.quantity}</td>
                    <td data-label="Fill">{t.fill_price ? formatPrice(Number(t.fill_price)) : "—"}</td>
                    <td data-label="Status">
                      <span className={`tag ${t.status === "filled" ? "tag-accent" : "tag-neutral"}`}>{t.status}</span>
                      {t.status === "rejected" && <div className="card-meta">{t.rejection_reason}</div>}
                    </td>
                    <td data-label="Thesis">{t.thesis}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === "reasoning" && summary.kind === "ai" && (
        <div className="stack">
          <div className="card elev-sm">
            <div className="card-kicker">Current scratchpad</div>
            {scratchpad?.content ? (
              <div className="card-body markdown-body">
                <Markdown>{scratchpad.content}</Markdown>
              </div>
            ) : (
              <p className="card-body">(nothing written yet)</p>
            )}
            {scratchpad?.updated_at && <div className="card-meta">{formatDateTime(scratchpad.updated_at)}</div>}
          </div>

          {!turns && <p className="text-muted">Loading turns…</p>}
          {turns && turns.length === 0 && <p className="text-muted">No wake-ups yet.</p>}
          {turns && turns.length > 0 && (
            <div className="table-wrap stack-mobile">
              <table className="table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Trigger</th>
                    <th>Tools used</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {turns.map((t) => (
                    <tr key={t.id} style={{ cursor: "pointer" }} onClick={() => setOpenTurnId(t.id)}>
                      <td data-label="When">{formatDateTime(t.created_at)}</td>
                      <td data-label="Trigger">{TURN_TRIGGER_LABELS[t.trigger]}</td>
                      <td data-label="Tools used">{t.tool_calls.length > 0 ? t.tool_calls.join(", ") : "—"}</td>
                      <td data-label="Cost">${t.cost_usd}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tradeModalOpen && (
        <TradeModal
          competitorId={summary.id}
          onClose={() => setTradeModalOpen(false)}
          onFilled={(trade) => {
            setTrades((prev) => [trade, ...(prev ?? [])]);
            setTradeModalOpen(false);
            onTradeFilled();
          }}
        />
      )}

      {openTurnId !== null && (
        <TurnTranscriptModal competitorId={summary.id} turnId={openTurnId} provider={provider} onClose={() => setOpenTurnId(null)} />
      )}
    </div>
  );
}
