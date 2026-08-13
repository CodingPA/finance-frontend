// Medium-Term Paper Trading League (docs/paper-trading-league-rules.md,
// docs/league-api.md): George vs. Claude, backend-enforced rules engine.
// Only one competition is seeded today, so this page skips a competition
// picker and just loads the first one -- add a picker later if a second
// competition ever gets created.

import { useEffect, useState } from "react";
import { realtime } from "../lib/ws";
import { extractGenericMessage } from "../lib/formErrors";
import { formatDateTime, formatPercent, formatPrice, formatUsd } from "../lib/format";
import { TradeModal } from "../components/TradeModal";
import { TurnTranscriptModal } from "../components/TurnTranscriptModal";
import { AddCompetitorModal } from "../components/AddCompetitorModal";
import {
  getCompetitor,
  getNextWakeups,
  getScoreboard,
  getScratchpad,
  listCompetitions,
  listCompetitors,
  listModels,
  listTrades,
  listTurns,
  triggerWakeup,
  type Competition,
  type CompetitorDetail,
  type CompetitorSummary,
  type LeagueModel,
  type NextWakeups,
  type Scoreboard,
  type Scratchpad,
  type Trade,
  type TurnSummary,
} from "../lib/league";

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

  const loadCompetitionData = async (competitionId: number) => {
    const [board, list] = await Promise.all([getScoreboard(competitionId), listCompetitors(competitionId)]);
    setScoreboard(board);
    setCompetitors(list);
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

  const handleJoined = (competitor: CompetitorSummary) => {
    setCompetitors((prev) => [...prev, competitor]);
    if (competition) loadCompetitionData(competition.id).catch(() => {});
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
  const selected = competitors.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="page">
      <div className="page-head">
        <h2>Paper Trading League</h2>
        {competition && (
          <>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ marginLeft: "auto" }}
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

      {wakeAllError && <p className="form-error">{wakeAllError}</p>}

      {loading && <p className="text-muted">Loading league…</p>}
      {error && <p className="form-error">{error}</p>}

      {!loading && !error && !competition && <p className="text-muted">No competition has been created yet.</p>}

      {competition && (
        <>
          <p className="text-muted">
            {competition.name} · {competition.start_date} – {competition.end_date} · ${competition.starting_capital} starting
            capital · max {formatPercent(Number(competition.max_position_pct))} per position, {formatPercent(Number(competition.max_index_pct))} in
            index funds ({competition.index_tickers.join(", ")})
          </p>

          {scoreboard && (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Competitor</th>
                    <th>Account value</th>
                    <th>Total return</th>
                    <th>Max drawdown</th>
                  </tr>
                </thead>
                <tbody>
                  {scoreboard.competitors.map((c) => (
                    <tr
                      key={c.id}
                      onClick={() => setSelectedId((prev) => (prev === c.id ? null : c.id))}
                      className={c.id === selectedId ? "league-row-active" : undefined}
                      style={{ cursor: "pointer" }}
                    >
                      <td>
                        {c.name} <span className={`tag ${c.kind === "ai" ? "tag-outline" : "tag-accent"}`}>{c.kind === "ai" ? "AI" : "YOU"}</span>
                      </td>
                      <td>{formatUsd(Number(c.account_value))}</td>
                      <td>{formatPercent(Number(c.total_return_pct))}</td>
                      <td>{formatPercent(Number(c.max_drawdown_pct))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {selected && (
            <CompetitorPanel
              key={selected.id}
              summary={selected}
              models={models}
              refreshSignal={refreshSignal}
              onTradeFilled={() => competition && loadCompetitionData(competition.id).catch(() => {})}
            />
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
}: {
  summary: CompetitorSummary;
  models: LeagueModel[];
  refreshSignal: number;
  onTradeFilled: () => void;
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
        <h3>{summary.name}</h3>
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
        <div className="table-wrap">
          {!detail && <p className="text-muted">Loading…</p>}
          {detail && detail.positions.length === 0 && <p className="text-muted">No open positions.</p>}
          {detail && (
            <table className="table">
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th>Value</th>
                  <th>Instrument</th>
                  <th>Qty</th>
                  <th>Avg cost</th>
                  <th>Opened</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>SPAXX (CASH)</td>
                  <td>{formatUsd(Number(detail.cash_balance))}</td>
                  <td colSpan={3} className="text-muted">
                    Cash
                  </td>
                  <td></td>
                </tr>
                {detail.positions.map((p, i) => (
                  <tr key={i}>
                    <td>{p.ticker}</td>
                    <td>{formatUsd(Number(p.current_value))}</td>
                    <td>
                      {p.instrument_type}
                      {p.strike && ` $${p.strike} exp ${p.expiration}`}
                      {p.is_short && <span className="tag tag-outline">SHORT LEG</span>}
                    </td>
                    <td>{p.quantity}</td>
                    <td>{formatPrice(Number(p.avg_cost))}</td>
                    <td>{formatDateTime(p.opened_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === "trades" && (
        <div className="table-wrap">
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
                    <td>{formatDateTime(t.created_at)}</td>
                    <td>{t.side}</td>
                    <td>
                      {t.ticker} {t.instrument_type !== "stock" && `${t.instrument_type} $${t.strike}`}
                    </td>
                    <td>{t.quantity}</td>
                    <td>{t.fill_price ? formatPrice(Number(t.fill_price)) : "—"}</td>
                    <td>
                      <span className={`tag ${t.status === "filled" ? "tag-accent" : "tag-neutral"}`}>{t.status}</span>
                      {t.status === "rejected" && <div className="card-meta">{t.rejection_reason}</div>}
                    </td>
                    <td>{t.thesis}</td>
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
            <p className="card-body">{scratchpad?.content || "(nothing written yet)"}</p>
            {scratchpad?.updated_at && <div className="card-meta">{formatDateTime(scratchpad.updated_at)}</div>}
          </div>

          {!turns && <p className="text-muted">Loading turns…</p>}
          {turns && turns.length === 0 && <p className="text-muted">No wake-ups yet.</p>}
          {turns && turns.length > 0 && (
            <div className="table-wrap">
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
                      <td>{formatDateTime(t.created_at)}</td>
                      <td>{t.trigger === "manual" ? "Manual" : "Self-scheduled"}</td>
                      <td>{t.tool_calls.length > 0 ? t.tool_calls.join(", ") : "—"}</td>
                      <td>${t.cost_usd}</td>
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
