// Dedicated per-competitor dashboard (finance-backend/docs/league-api.md): full position/trade
// history plus, for AI competitors, the current scratchpad snapshot and a
// "daily log" of every wake-up's full transcript. The scratchpad is the
// agent's latest thinking (what its next wake-up starts from); the daily log
// is the permanent record of every wake-up that produced it -- forced
// check-in, self-scheduled, or manual -- distinct concepts, both surfaced
// here since neither replaces the other.

import { Fragment, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useIsMobile } from "../hooks/useIsMobile";
import { realtime, LeagueFeedSocket } from "../lib/ws";
import { extractGenericMessage } from "../lib/formErrors";
import { formatDateTime, formatPercent, formatPrice, formatSignedUsd, formatTime, formatUsd, parseDateOnly } from "../lib/format";
import { Markdown } from "../components/Markdown";
import { TradeModal } from "../components/TradeModal";
import { TurnTranscriptModal } from "../components/TurnTranscriptModal";
import { TickerMemoryModal } from "../components/TickerMemoryModal";
import { CompetitorAvatar } from "../components/CompetitorAvatar";
import { BudgetBars } from "../components/BudgetBars";
import {
  cancelTrade,
  getCompetitor,
  getNextWakeups,
  getScoreboard,
  getScratchpad,
  getTickerMemories,
  listCompetitions,
  listCompetitors,
  listModels,
  listTrades,
  listTurns,
  pnlClass,
  positionPnl,
  positionToTradePrefill,
  refreshCompetitor,
  triggerWakeup,
  TURN_TRIGGER_LABELS,
  type CompetitorDetail,
  type CompetitorSummary,
  type LeagueModel,
  type NextWakeups,
  type Position,
  type Scoreboard,
  type Scratchpad,
  type TickerMemory,
  type Trade,
  type TurnSummary,
} from "../lib/league";

// A refresh() POST only confirms the job was queued -- if the
// league.competitor_refreshed push doesn't land within this window (socket
// down, Redis hiccup), fall back to a plain re-fetch instead of spinning
// forever (finance-backend/docs/league-api.md's "Building the manual-refresh button").
const REFRESH_FALLBACK_MS = 15_000;

// Trades don't carry per-trade realized P/L or a close reason (target_price/
// dead_price live on Position, not Trade -- they're revisable anytime, so a
// Trade-level snapshot would go stale the moment a competitor moved a stop
// on a position it already holds) -- this derives open/closed/rejected from
// side + status instead of fabricating a dollar result.
function tradeResultLabel(t: Trade): string {
  if (t.status === "pending") return "queued";
  if (t.status === "rejected") return "rejected";
  if (t.status === "cancelled") return "cancelled";
  return t.side === "sell" || t.side === "buy_to_close" ? "closed" : "open";
}

function formatShortDate(value: string | null | undefined): string {
  if (!value) return "";
  const date = parseDateOnly(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function CompetitorDashboardPage() {
  const { id } = useParams();
  const competitorId = Number(id);
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  const [detail, setDetail] = useState<CompetitorDetail | null>(null);
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [scratchpad, setScratchpad] = useState<Scratchpad | null>(null);
  const [tickerMemories, setTickerMemories] = useState<TickerMemory[] | null>(null);
  const [openTickerMemory, setOpenTickerMemory] = useState<TickerMemory | null>(null);
  const [turns, setTurns] = useState<TurnSummary[] | null>(null);
  const [nextWakeups, setNextWakeups] = useState<NextWakeups | null>(null);
  const [models, setModels] = useState<LeagueModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshSignal, setRefreshSignal] = useState(0);

  // "new" for the header's New trade button, a Position for the Sell/Buy-to-
  // close button on an open positions row (prefills the modal to close it).
  const [tradeModalTarget, setTradeModalTarget] = useState<"new" | Position | null>(null);
  const [openTurnId, setOpenTurnId] = useState<number | null>(null);
  const [expandedTurnId, setExpandedTurnId] = useState<number | null>(null);
  const [waking, setWaking] = useState(false);

  const [competitionId, setCompetitionId] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // For the RANK badge and MAX DRAWDOWN stat -- CompetitorDetail has
  // neither (drawdown is only on the scoreboard row; rank isn't a field at
  // all, just this competitor's position in the scoreboard's sorted list).
  const [scoreboard, setScoreboard] = useState<Scoreboard | null>(null);
  // Cosmetic identity (color/avatar) lives on the list-endpoint's
  // CompetitorSummary, not CompetitorDetail -- fetched separately and
  // joined by id rather than assumed onto `detail`.
  const [competitorSummary, setCompetitorSummary] = useState<CompetitorSummary | null>(null);
  const [mandateExpanded, setMandateExpanded] = useState(false);
  const [expandedTradeId, setExpandedTradeId] = useState<number | null>(null);
  const [cancelingTradeId, setCancelingTradeId] = useState<number | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

  useEffect(() => {
    listModels()
      .then(setModels)
      .catch(() => {});
  }, []);

  // CompetitorDetail doesn't carry its competition id, but the live feed
  // socket needs one to connect -- only one competition is seeded today
  // (same assumption LeaguePage makes), so take the first.
  useEffect(() => {
    listCompetitions()
      .then((all) => setCompetitionId(all[0]?.id ?? null))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!competitionId) return;
    let cancelled = false;
    getScoreboard(competitionId)
      .then((b) => !cancelled && setScoreboard(b))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [competitionId, refreshSignal]);

  useEffect(() => {
    if (!competitionId) return;
    let cancelled = false;
    listCompetitors(competitionId)
      .then((list) => !cancelled && setCompetitorSummary(list.find((c) => c.id === competitorId) ?? null))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [competitionId, competitorId, refreshSignal]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getCompetitor(competitorId)
      .then((d) => !cancelled && setDetail(d))
      .catch((err) => {
        if (!cancelled) setError(extractGenericMessage(err, "Couldn't load this competitor."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    listTrades(competitorId)
      .then((t) => !cancelled && setTrades(t))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [competitorId, refreshSignal]);

  useEffect(() => {
    if (!detail || detail.kind !== "ai") return;
    let cancelled = false;
    getScratchpad(competitorId)
      .then((s) => !cancelled && setScratchpad(s))
      .catch(() => {});
    getTickerMemories(competitorId)
      .then((m) => !cancelled && setTickerMemories(m))
      .catch(() => {});
    listTurns(competitorId)
      .then((t) => !cancelled && setTurns(t))
      .catch(() => {});
    getNextWakeups(competitorId)
      .then((w) => !cancelled && setNextWakeups(w))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [competitorId, detail?.kind, refreshSignal]);

  // league.trade_activity / league.wakeup_complete / league.wakeup_failed --
  // only refresh for pushes about this competitor, not every AI in the league.
  useEffect(() => {
    return realtime.on("notification.new", (message) => {
      const type = message.notification_type;
      if (typeof type !== "string" || !type.startsWith("league.")) return;
      const payload = message.payload;
      if (payload && typeof payload === "object" && (payload as Record<string, unknown>).competitor_id === competitorId) {
        setRefreshSignal((k) => k + 1);
      }
    });
  }, [competitorId]);

  // league.competitor_refreshed (finance-backend/docs/league-api.md's "Live competition
  // feed") -- the manual-refresh button's reply. Its payload omits
  // `positions`, so rather than patch fields in place, bump refreshSignal to
  // pull a full getCompetitor() through the effect above -- that's the only
  // way the positions table's current_price/current_value pick up the new
  // marks too.
  useEffect(() => {
    if (!competitionId) return;
    const socket = new LeagueFeedSocket(competitionId);
    const off = socket.on("league.competitor_refreshed", (msg) => {
      const competitor = msg.competitor as { id?: number } | undefined;
      if (competitor?.id !== competitorId) return;
      setRefreshing(false);
      if (refreshTimeoutRef.current) {
        clearTimeout(refreshTimeoutRef.current);
        refreshTimeoutRef.current = null;
      }
      setRefreshSignal((k) => k + 1);
    });
    return () => {
      off();
      socket.close();
      if (refreshTimeoutRef.current) {
        clearTimeout(refreshTimeoutRef.current);
        refreshTimeoutRef.current = null;
      }
    };
  }, [competitionId, competitorId]);

  const handleWakeUp = async () => {
    setWaking(true);
    try {
      await triggerWakeup(competitorId);
    } catch (err) {
      setError(extractGenericMessage(err, "Couldn't trigger a wake-up."));
    } finally {
      setWaking(false);
    }
  };

  // Both outcomes (a clean cancel, or losing the race against the resolver)
  // come back as the same full Trade row -- upsert it in place either way,
  // no follow-up fetch needed (see cancelTrade()'s comment in lib/league.ts).
  const handleCancelTrade = async (tradeId: number) => {
    setCancelError(null);
    setCancelingTradeId(tradeId);
    try {
      const updated = await cancelTrade(competitorId, tradeId);
      setTrades((prev) => (prev ? prev.map((t) => (t.id === updated.id ? updated : t)) : prev));
    } catch (err) {
      setCancelError(extractGenericMessage(err, "Couldn't cancel that order."));
    } finally {
      setCancelingTradeId(null);
    }
  };

  const handleRefresh = async () => {
    setRefreshError(null);
    setRefreshing(true);
    try {
      await refreshCompetitor(competitorId);
    } catch (err) {
      setRefreshing(false);
      setRefreshError(extractGenericMessage(err, "Couldn't refresh prices."));
      return;
    }
    // league.competitor_refreshed normally clears this well before the
    // fallback fires -- see the socket effect above.
    if (refreshTimeoutRef.current) clearTimeout(refreshTimeoutRef.current);
    refreshTimeoutRef.current = setTimeout(() => {
      refreshTimeoutRef.current = null;
      setRefreshing(false);
      setRefreshSignal((k) => k + 1);
    }, REFRESH_FALLBACK_MS);
  };

  const provider = models.find((m) => m.model_id === detail?.assistant_model)?.provider ?? "anthropic";

  const scoreboardIndex = scoreboard?.competitors.findIndex((c) => c.id === competitorId) ?? -1;
  const rank = scoreboardIndex >= 0 ? scoreboardIndex + 1 : null;
  const maxDrawdownPct = scoreboardIndex >= 0 ? Number(scoreboard!.competitors[scoreboardIndex].max_drawdown_pct) : null;

  // Step through the scoreboard's own order (best return first) rather than
  // competitor id -- id order doesn't mean anything competitively.
  const prevCompetitor = scoreboardIndex > 0 ? scoreboard!.competitors[scoreboardIndex - 1] : null;
  const nextCompetitor =
    scoreboardIndex >= 0 && scoreboardIndex < (scoreboard?.competitors.length ?? 0) - 1
      ? scoreboard!.competitors[scoreboardIndex + 1]
      : null;

  const accountValue = detail ? Number(detail.account_value) : 0;
  const cashBalance = detail ? Number(detail.cash_balance) : 0;
  const openRisk = accountValue - cashBalance;
  const cashPctOfBook = accountValue > 0 ? cashBalance / accountValue : null;

  // "3 positions, all 1DTE" -- only meaningful when every open option shares
  // the same days-to-expiration; mixed expirations just show the count.
  const optionDtes = Array.from(
    new Set(
      (detail?.positions ?? [])
        .filter((p) => p.expiration)
        .map((p) => Math.max(0, Math.ceil((parseDateOnly(p.expiration as string).getTime() - Date.now()) / 86_400_000))),
    ),
  );
  const dteSummary = optionDtes.length === 1 ? `, all ${optionDtes[0]}DTE` : optionDtes.length > 1 ? ", mixed DTE" : "";

  const apiCost = turns ? turns.reduce((sum, t) => sum + Number(t.cost_usd), 0) : null;

  return (
    <div className="page">
      <Link to="/league" className="text-muted">
        ← Back to League
      </Link>

      {loading && <p className="text-muted">Loading…</p>}
      {error && <p className="form-error">{error}</p>}

      {detail && (
        <>
          <div className="competitor-hero">
            <div>
              <div className="competitor-hero-tags">
                {rank !== null && <span className="rank-badge">RANK {String(rank).padStart(2, "0")}</span>}
                <span className="tag tag-neutral">{detail.kind === "ai" ? "AI OPERATOR" : "YOU"}</span>
              </div>
              <h1 className="competitor-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <CompetitorAvatar color={competitorSummary?.color} avatar={competitorSummary?.avatar} size={32} />
                {detail.name}
              </h1>
              {detail.assistant_model && <p className="text-muted">{detail.assistant_model}</p>}
            </div>
            <div className="competitor-hero-right">
              <div className="competitor-hero-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleRefresh}
                  disabled={refreshing}
                  title="Force a live re-quote of this competitor's held tickers, right now"
                >
                  {refreshing ? "Refreshing…" : "Refresh prices"}
                </button>
                {detail.kind === "human" && (
                  <button type="button" className="btn btn-primary" onClick={() => setTradeModalTarget("new")}>
                    New trade
                  </button>
                )}
                {detail.kind === "ai" && (
                  <button type="button" className="btn btn-primary" onClick={handleWakeUp} disabled={waking}>
                    {waking ? "Waking…" : "Wake up now"}
                  </button>
                )}
              </div>
              {scoreboard && (
                <div className="competitor-hero-nav">
                  <button
                    type="button"
                    className="btn btn-secondary btn-icon"
                    onClick={() => prevCompetitor && navigate(`/league/competitors/${prevCompetitor.id}`)}
                    disabled={!prevCompetitor}
                    aria-label="Previous competitor"
                    title={prevCompetitor ? `Previous: ${prevCompetitor.name}` : undefined}
                  >
                    ‹
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-icon"
                    onClick={() => nextCompetitor && navigate(`/league/competitors/${nextCompetitor.id}`)}
                    disabled={!nextCompetitor}
                    aria-label="Next competitor"
                    title={nextCompetitor ? `Next: ${nextCompetitor.name}` : undefined}
                  >
                    ›
                  </button>
                </div>
              )}
            </div>
          </div>

          {refreshError && <p className="form-error">{refreshError}</p>}

          <div className="stat-strip">
            <div className="stat-strip-item">
              <div className="card-kicker">Account value</div>
              <div className="card-title">{formatUsd(accountValue)}</div>
            </div>
            <div className="stat-strip-item">
              <div className="card-kicker">Total return</div>
              <div className="card-title">{formatPercent(Number(detail.total_return_pct))}</div>
            </div>
            <div className="stat-strip-item">
              <div className="card-kicker">Cash</div>
              <div className="card-title">{formatUsd(cashBalance)}</div>
              {cashPctOfBook !== null && <div className="card-meta">{formatPercent(cashPctOfBook)} of book</div>}
            </div>
            <div className="stat-strip-item">
              <div className="card-kicker">Open risk</div>
              <div className="card-title">{formatUsd(openRisk)}</div>
              <div className="card-meta">
                {detail.positions.length} position{detail.positions.length === 1 ? "" : "s"}
                {dteSummary}
              </div>
            </div>
            <div className="stat-strip-item">
              <div className="card-kicker">Max drawdown</div>
              <div className="card-title">{maxDrawdownPct !== null ? formatPercent(maxDrawdownPct) : "—"}</div>
            </div>
            {detail.kind === "ai" && (
              <div className="stat-strip-item">
                <div className="card-kicker">API cost</div>
                <div className="card-title">{apiCost !== null ? formatUsd(apiCost) : "—"}</div>
                {turns && <div className="card-meta">{turns.length} wake-up{turns.length === 1 ? "" : "s"}</div>}
              </div>
            )}
          </div>

          <div className="competitor-layout">
            <div className="stack">
              <div className="card elev-sm stack">
                <div className="page-head" style={{ marginBottom: 0 }}>
                  <div className="card-title">Open positions</div>
                  {detail.prices_as_of && (
                    <span className="text-muted" style={{ marginLeft: "auto", fontSize: 12 }} title="Oldest quote among the marks below">
                      marks as of {formatDateTime(detail.prices_as_of)}
                    </span>
                  )}
                </div>
                <div className="table-wrap table-scroll">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Ticker</th>
                        {!isMobile && <th>Instrument</th>}
                        <th>Qty</th>
                        <th>Avg cost</th>
                        <th>Mark</th>
                        <th>Unrealized</th>
                        {!isMobile && <th>Target / dead</th>}
                        {detail.kind === "human" && <th>Actions</th>}
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td data-label="Ticker">SPAXX</td>
                        {!isMobile && (
                          <td data-label="Instrument" className="text-muted">
                            Cash
                          </td>
                        )}
                        <td data-label="Qty">—</td>
                        <td data-label="Avg cost">—</td>
                        <td data-label="Mark">—</td>
                        <td data-label="Unrealized">{formatUsd(cashBalance)}</td>
                        {!isMobile && <td data-label="Target / dead"></td>}
                        {detail.kind === "human" && <td data-label="Actions"></td>}
                      </tr>
                      {detail.positions.map((p, i) => {
                        const pnl = positionPnl(p);
                        return (
                          <tr key={i}>
                            <td data-label="Ticker">
                              <strong>{p.ticker}</strong>
                              {isMobile && p.is_short && <span className="tag tag-outline">SHORT LEG</span>}
                            </td>
                            {!isMobile && (
                              <td data-label="Instrument">
                                {p.instrument_type}
                                {p.strike && ` $${p.strike} exp ${formatShortDate(p.expiration)}`}
                                {p.is_short && <span className="tag tag-outline">SHORT LEG</span>}
                              </td>
                            )}
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
                            {!isMobile && (
                              <td data-label="Target / dead" className="text-muted">
                                {p.target_price ? formatPrice(Number(p.target_price)) : "—"} /{" "}
                                {p.dead_price ? formatPrice(Number(p.dead_price)) : "—"}
                              </td>
                            )}
                            {detail.kind === "human" && (
                              <td data-label="Actions">
                                <button type="button" className="btn btn-secondary" onClick={() => setTradeModalTarget(p)}>
                                  {p.is_short ? "Buy to close" : "Sell"}
                                </button>
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {detail.positions.length === 0 && <p className="text-muted">No open positions.</p>}
                </div>
              </div>

              <div className="card elev-sm stack">
                <div className="page-head" style={{ marginBottom: 0 }}>
                  <div className="card-title">Trade log</div>
                  <span className="text-muted" style={{ marginLeft: "auto", fontSize: 12 }}>
                    Every fill carries a thesis — click a row to read it.
                  </span>
                </div>
                <div className="table-wrap table-scroll trade-log-scroll">
                  {!trades && <p className="text-muted">Loading…</p>}
                  {trades && trades.length === 0 && <p className="text-muted">No trades yet.</p>}
                  {trades && trades.length > 0 && (
                    <table className="table">
                      <thead>
                        <tr>
                          <th>When</th>
                          <th>Side</th>
                          <th>Instrument</th>
                          <th>Fill</th>
                          <th>Limit</th>
                          <th>Result</th>
                        </tr>
                      </thead>
                      <tbody>
                        {trades.map((t) => (
                          <Fragment key={t.id}>
                            <tr
                              onClick={() => setExpandedTradeId((prev) => (prev === t.id ? null : t.id))}
                              className={t.id === expandedTradeId ? "league-row-active" : undefined}
                              style={{ cursor: "pointer" }}
                            >
                              <td data-label="When">{formatTime(t.created_at)}</td>
                              <td data-label="Side">
                                <strong>{t.side.replace("_", " ").toUpperCase()}</strong>
                              </td>
                              <td data-label="Instrument">
                                <strong>{t.ticker}</strong>{" "}
                                {t.instrument_type !== "stock" && `${t.instrument_type} $${t.strike} exp ${formatShortDate(t.expiration)}`}
                              </td>
                              <td data-label="Fill">{t.fill_price ? formatPrice(Number(t.fill_price)) : "—"}</td>
                              <td data-label="Limit" className="text-muted">
                                {t.limit_price ? formatPrice(Number(t.limit_price)) : "—"}
                              </td>
                              <td data-label="Result" className={t.status !== "filled" ? "text-muted" : undefined}>
                                {t.status === "pending" && "\u{1F550} "}
                                {tradeResultLabel(t)}
                              </td>
                            </tr>
                            {expandedTradeId === t.id && (
                              <tr>
                                <td colSpan={6} className="league-expanded-cell">
                                  <div className="card-kicker">Thesis</div>
                                  <p className="card-body">{t.thesis}</p>
                                  {t.status === "rejected" && <p className="form-error">{t.rejection_reason}</p>}
                                  {t.status === "pending" && (
                                    <div className="page-head" style={{ marginBottom: 0 }}>
                                      <p className="text-muted" style={{ margin: 0 }}>
                                        Queued -- fills at the next market open.
                                      </p>
                                      {detail.kind === "human" && (
                                        <button
                                          type="button"
                                          className="btn btn-secondary"
                                          style={{ marginLeft: "auto" }}
                                          onClick={() => handleCancelTrade(t.id)}
                                          disabled={cancelingTradeId === t.id}
                                        >
                                          {cancelingTradeId === t.id ? "Cancelling…" : "Cancel order"}
                                        </button>
                                      )}
                                    </div>
                                  )}
                                  {cancelError && expandedTradeId === t.id && <p className="form-error">{cancelError}</p>}
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>

              {detail.kind === "ai" && (
                <div className="card elev-sm stack">
                  <div className="page-head" style={{ marginBottom: 0 }}>
                    <div className="card-title">Ticker research</div>
                    <span className="text-muted" style={{ marginLeft: "auto", fontSize: 12 }}>
                      Click a ticker for its notes.
                    </span>
                  </div>
                  {!tickerMemories && <p className="text-muted">Loading…</p>}
                  {tickerMemories && tickerMemories.length === 0 && <p className="text-muted">No ticker research yet.</p>}
                  {tickerMemories && tickerMemories.length > 0 && (
                    <div className="ticker-memory-list">
                      {tickerMemories.map((m) => (
                        <button
                          key={m.ticker}
                          type="button"
                          className="ticker-memory-item"
                          onClick={() => setOpenTickerMemory(m)}
                        >
                          <strong>{m.ticker}</strong>
                          <span className="text-muted" style={{ fontSize: 12 }}>
                            {formatDateTime(m.updated_at)}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="stack">
              {detail.kind === "ai" && (
                <BudgetBars
                  totalBudgetUsd={detail.total_budget_usd}
                  weeklyBudgetUsd={detail.weekly_budget_usd}
                  apiCostUsd={apiCost !== null ? String(apiCost) : null}
                  weekSpentUsd={detail.week_spent_usd}
                  todaySpentUsd={detail.today_spent_usd}
                />
              )}

              {detail.kind === "ai" && nextWakeups && (nextWakeups.forced_checkins.length > 0 || nextWakeups.self_scheduled.length > 0) && (
                <div className="card elev-sm stack">
                  <div className="card-title">Wake schedule</div>
                  <div className="stack" style={{ gap: 6 }}>
                    {nextWakeups.forced_checkins.map((c, i) => (
                      <div key={`forced-${i}`} className="page-head" style={{ marginBottom: 0 }} title="Forced check-in">
                        <span>{c.label}</span>
                        <span className="text-muted" style={{ marginLeft: "auto" }}>
                          {formatDateTime(c.next_run_at)}
                        </span>
                      </div>
                    ))}
                    {nextWakeups.self_scheduled.map((w) => (
                      <div key={`self-${w.id}`} className="page-head" style={{ marginBottom: 0 }} title={w.reason}>
                        <span>Self-scheduled</span>
                        <span className="text-muted" style={{ marginLeft: "auto" }}>
                          {formatDateTime(w.run_at)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {detail.kind === "ai" && (
                <div className="card elev-sm stack">
                  <div className="card-title">Latest scratchpad</div>
                  {scratchpad?.content ? (
                    <div className="card-body markdown-body">
                      <Markdown>{scratchpad.content}</Markdown>
                    </div>
                  ) : (
                    <p className="card-body">(nothing written yet)</p>
                  )}
                  {scratchpad?.updated_at && <div className="card-meta">{formatDateTime(scratchpad.updated_at)}</div>}
                  {turns && turns.length > 0 && (
                    <button type="button" className="btn btn-ghost" style={{ alignSelf: "flex-start", padding: 0 }} onClick={() => setOpenTurnId(turns[0].id)}>
                      Full transcript
                    </button>
                  )}
                </div>
              )}

              {detail.system_prompt && (
                <div className="card elev-sm stack">
                  <div className="page-head" style={{ marginBottom: 0 }}>
                    <div className="card-title">Mandate</div>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ marginLeft: "auto", padding: 0 }}
                      onClick={() => setMandateExpanded((v) => !v)}
                    >
                      {mandateExpanded ? "Collapse" : "Expand"}
                    </button>
                  </div>
                  <p className={mandateExpanded ? "card-body" : "card-body clamp-text"}>{detail.system_prompt}</p>
                </div>
              )}
            </div>
          </div>

          {detail.kind === "ai" && (
            <div className="card elev-sm stack">
              <div className="card-title">Daily log</div>
              <p className="card-body">
                Every time this competitor woke up -- forced check-in, self-scheduled, or manual -- and what it did. Click a row for the
                full transcript.
              </p>
              {!turns && <p className="text-muted">Loading…</p>}
              {turns && turns.length === 0 && <p className="text-muted">No wake-ups yet.</p>}
              {turns && turns.length > 0 && isMobile && (
                <div className="league-mobile-list">
                  {turns.map((t) => {
                    const expanded = t.id === expandedTurnId;
                    return (
                      <div className="league-mobile-item" key={t.id}>
                        <div
                          className="league-mobile-row"
                          onClick={() => setExpandedTurnId((prev) => (prev === t.id ? null : t.id))}
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
                          <span className="league-mobile-name">{formatDateTime(t.created_at)}</span>
                        </div>
                        {expanded && (
                          <div className="league-mobile-expand">
                            <ul className="league-mobile-positions">
                              <li className="league-mobile-position-row">
                                <span className="league-mobile-position-ticker">Trigger</span>
                                <span className="league-mobile-position-value">{TURN_TRIGGER_LABELS[t.trigger]}</span>
                              </li>
                              <li className="league-mobile-position-row">
                                <span className="league-mobile-position-ticker">Tools used</span>
                                <span className="league-mobile-position-value">
                                  {t.tool_calls.length > 0 ? t.tool_calls.join(", ") : "—"}
                                </span>
                              </li>
                              <li className="league-mobile-position-row">
                                <span className="league-mobile-position-ticker">Cost</span>
                                <span className="league-mobile-position-value">${t.cost_usd}</span>
                              </li>
                            </ul>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {turns && turns.length > 0 && !isMobile && (
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
        </>
      )}

      {detail && tradeModalTarget && (
        <TradeModal
          competitorId={detail.id}
          prefill={tradeModalTarget !== "new" ? positionToTradePrefill(tradeModalTarget) : undefined}
          onClose={() => setTradeModalTarget(null)}
          onFilled={(trade) => {
            setTrades((prev) => [trade, ...(prev ?? [])]);
            setTradeModalTarget(null);
            setRefreshSignal((k) => k + 1);
          }}
        />
      )}

      {detail && openTurnId !== null && (
        <TurnTranscriptModal competitorId={detail.id} turnId={openTurnId} provider={provider} onClose={() => setOpenTurnId(null)} />
      )}

      {openTickerMemory && <TickerMemoryModal memory={openTickerMemory} onClose={() => setOpenTickerMemory(null)} />}
    </div>
  );
}
