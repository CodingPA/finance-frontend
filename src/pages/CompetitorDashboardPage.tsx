// Dedicated per-competitor dashboard (docs/league-api.md): full position/trade
// history plus, for AI competitors, the current scratchpad snapshot and a
// "daily log" of every wake-up's full transcript. The scratchpad is the
// agent's latest thinking (what its next wake-up starts from); the daily log
// is the permanent record of every wake-up that produced it -- forced
// check-in, self-scheduled, or manual -- distinct concepts, both surfaced
// here since neither replaces the other.

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { realtime } from "../lib/ws";
import { extractGenericMessage } from "../lib/formErrors";
import { formatDateTime, formatPercent, formatPrice, formatUsd } from "../lib/format";
import { TradeModal } from "../components/TradeModal";
import { TurnTranscriptModal } from "../components/TurnTranscriptModal";
import {
  getCompetitor,
  getNextWakeups,
  getScratchpad,
  listModels,
  listTrades,
  listTurns,
  triggerWakeup,
  TURN_TRIGGER_LABELS,
  type CompetitorDetail,
  type LeagueModel,
  type NextWakeups,
  type Scratchpad,
  type Trade,
  type TurnSummary,
} from "../lib/league";

export function CompetitorDashboardPage() {
  const { id } = useParams();
  const competitorId = Number(id);

  const [detail, setDetail] = useState<CompetitorDetail | null>(null);
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [scratchpad, setScratchpad] = useState<Scratchpad | null>(null);
  const [turns, setTurns] = useState<TurnSummary[] | null>(null);
  const [nextWakeups, setNextWakeups] = useState<NextWakeups | null>(null);
  const [models, setModels] = useState<LeagueModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshSignal, setRefreshSignal] = useState(0);

  const [tradeModalOpen, setTradeModalOpen] = useState(false);
  const [openTurnId, setOpenTurnId] = useState<number | null>(null);
  const [waking, setWaking] = useState(false);

  useEffect(() => {
    listModels()
      .then(setModels)
      .catch(() => {});
  }, []);

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

  const provider = models.find((m) => m.model_id === detail?.assistant_model)?.provider ?? "anthropic";

  return (
    <div className="page">
      <Link to="/league" className="text-muted">
        ← Back to League
      </Link>

      {loading && <p className="text-muted">Loading…</p>}
      {error && <p className="form-error">{error}</p>}

      {detail && (
        <>
          <div className="page-head">
            <h2>{detail.name}</h2>
            <span className={`tag ${detail.kind === "ai" ? "tag-outline" : "tag-accent"}`}>{detail.kind === "ai" ? "AI" : "YOU"}</span>
            {detail.assistant_model && <span className="tag tag-neutral">{detail.assistant_model}</span>}
            {detail.kind === "human" && (
              <button type="button" className="btn btn-primary" style={{ marginLeft: "auto" }} onClick={() => setTradeModalOpen(true)}>
                New trade
              </button>
            )}
            {detail.kind === "ai" && (
              <button type="button" className="btn btn-secondary" style={{ marginLeft: "auto" }} onClick={handleWakeUp} disabled={waking}>
                {waking ? "Waking…" : "Wake up now"}
              </button>
            )}
          </div>

          {detail.system_prompt && <p className="card-body">{detail.system_prompt}</p>}

          <p className="text-muted">
            Cash {formatUsd(Number(detail.cash_balance))} · Account value {formatUsd(Number(detail.account_value))} · Total return{" "}
            {formatPercent(Number(detail.total_return_pct))}
          </p>

          {detail.kind === "ai" && nextWakeups && (nextWakeups.forced_checkins.length > 0 || nextWakeups.self_scheduled.length > 0) && (
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

          <div className="card elev-sm stack">
            <div className="card-title">Positions</div>
            <div className="table-wrap">
              {detail.positions.length === 0 && <p className="text-muted">No open positions.</p>}
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
            </div>
          </div>

          <div className="card elev-sm stack">
            <div className="card-title">Trades</div>
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
          </div>

          {detail.kind === "ai" && (
            <div className="card elev-sm stack">
              <div className="card-title">Scratchpad</div>
              <p className="card-body">{scratchpad?.content || "(nothing written yet)"}</p>
              {scratchpad?.updated_at && <div className="card-meta">{formatDateTime(scratchpad.updated_at)}</div>}
            </div>
          )}

          {detail.kind === "ai" && (
            <div className="card elev-sm stack">
              <div className="card-title">Daily log</div>
              <p className="card-body">
                Every time this competitor woke up -- forced check-in, self-scheduled, or manual -- and what it did. Click a row for the
                full transcript.
              </p>
              {!turns && <p className="text-muted">Loading…</p>}
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
                          <td>{TURN_TRIGGER_LABELS[t.trigger]}</td>
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
        </>
      )}

      {detail && tradeModalOpen && (
        <TradeModal
          competitorId={detail.id}
          onClose={() => setTradeModalOpen(false)}
          onFilled={(trade) => {
            setTrades((prev) => [trade, ...(prev ?? [])]);
            setTradeModalOpen(false);
            setRefreshSignal((k) => k + 1);
          }}
        />
      )}

      {detail && openTurnId !== null && (
        <TurnTranscriptModal competitorId={detail.id} turnId={openTurnId} provider={provider} onClose={() => setOpenTurnId(null)} />
      )}
    </div>
  );
}
