// Submit a trade for the user's own human competitor
// (POST /api/league/competitors/{id}/trades/). A rejection isn't a form
// error -- it's a normal 400 carrying a full trade row with `rejection_reason`
// (the rules engine's human-readable explanation), rendered inline so the
// user can see exactly why and adjust, same as a real broker's reject message.
// A 201 can carry status "pending" (queued for the next market open, only
// possible when the competition has restrict_after_hours_trading on) as well
// as "filled" -- onFilled fires for both, since neither is a rejection; the
// trade list it lands in is what shows the pending/queued state.

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Modal } from "./Modal";
import {
  getOptionsChain,
  getOptionsExpirations,
  getQuote,
  type OptionContract,
  type OptionsChain,
  type Quote,
} from "../lib/companies";
import {
  positionToTradePrefill,
  submitTrade,
  type InstrumentType,
  type NewTrade,
  type Position,
  type Trade,
  type TradePrefill,
  type TradeSide,
} from "../lib/league";
import { extractFieldErrors, extractGenericMessage, type FieldErrors } from "../lib/formErrors";
import { parseDateOnly } from "../lib/format";

const SIDE_OPTIONS: { value: TradeSide; short: string; label: string }[] = [
  { value: "buy", short: "Buy", label: "Buy (open/add)" },
  { value: "sell", short: "Sell", label: "Sell (close/reduce)" },
  { value: "sell_to_open", short: "Sell(open)", label: "Sell to open (covered call / cash-covered put)" },
  { value: "buy_to_close", short: "Buy(close)", label: "Buy to close" },
];

// Real ticker symbols top out around 5 chars (a few OTC/ADR outliers run to
// 6-7) -- caps accidental pastes/typos rather than any real product limit.
const TICKER_MAX_LENGTH = 7;

const STRIKE_COUNT_OPTIONS = [5, 10, 15, 20, 25];

// However many expiration badges fit comfortably on one line before the
// rest fold into the "More" dropdown -- a handful of near-term dates cover
// the common case, everything further out is a less frequent pick anyway.
const VISIBLE_EXPIRATIONS = 4;

function formatExpirationShort(date: string): string {
  const d = parseDateOnly(date);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Debounce a live-priced ticker/expiration lookup so every keystroke doesn't
// fire a request -- 400ms is long enough to skip mid-typing characters, short
// enough that a finished ticker feels instant.
const QUOTE_DEBOUNCE_MS = 400;
const QUOTE_POLL_MS = 5000;

/** One row of the two-sided chain table -- a strike with whichever of
 *  call/put the trimmed chain actually returned for it (usually both, but
 *  calls/puts are trimmed to N-closest-to-money independently so an edge
 *  strike can have just one side). */
interface ChainRow {
  strike: number;
  call?: OptionContract;
  put?: OptionContract;
}

function buildChainRows(chain: OptionsChain | null): ChainRow[] {
  if (!chain) return [];
  const byStrike = new Map<number, ChainRow>();
  const rowFor = (strike: number): ChainRow => {
    let row = byStrike.get(strike);
    if (!row) {
      row = { strike };
      byStrike.set(strike, row);
    }
    return row;
  };
  for (const c of chain.calls) rowFor(c.strike_price).call = c;
  for (const p of chain.puts) rowFor(p.strike_price).put = p;
  return Array.from(byStrike.values()).sort((a, b) => a.strike - b.strike);
}

function positionBadgeLabel(p: Position): string {
  return p.instrument_type === "stock" ? p.ticker : `${p.ticker} ${p.instrument_type} $${Number(p.strike)}`;
}

function positionBadgeSub(p: Position): string {
  const unit = p.instrument_type === "stock" ? "sh" : "ct";
  return `${p.quantity} ${unit}${p.is_short ? " short" : ""}`;
}

export function TradeModal({
  competitorId,
  positions = [],
  prefill,
  onClose,
  onFilled,
}: {
  competitorId: number;
  /** The competitor's own open positions -- rendered as quick-select badges
   *  above the ticker field so closing something you already hold doesn't
   *  require retyping its ticker/instrument/quantity. */
  positions?: Position[];
  /** Pre-fills the form to close an existing position (the Sell/Buy-to-
   *  close button on an open positions table) -- everything stays editable,
   *  this just saves re-typing what the position already tells us. */
  prefill?: TradePrefill;
  onClose: () => void;
  onFilled: (trade: Trade) => void;
}) {
  const [ticker, setTicker] = useState(prefill?.ticker ?? "");
  const [side, setSide] = useState<TradeSide>(prefill?.side ?? "buy");
  const [instrumentType, setInstrumentType] = useState<InstrumentType>(prefill?.instrumentType ?? "stock");
  const [quantity, setQuantity] = useState(prefill ? String(prefill.quantity) : "");
  const [strike, setStrike] = useState(prefill?.strike ?? "");
  const [expiration, setExpiration] = useState(prefill?.expiration ?? "");
  const [limitPrice, setLimitPrice] = useState("");
  const [targetPrice, setTargetPrice] = useState("");
  const [deadPrice, setDeadPrice] = useState("");
  const [thesis, setThesis] = useState("");

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [rejection, setRejection] = useState<Trade | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isOption = instrumentType !== "stock";
  // target_price/dead_price only mean anything on a trade that opens or adds
  // to a position -- a closing side has nothing left afterward to attach a
  // take-profit/stop level to.
  const isOpening = side === "buy" || side === "sell_to_open";

  // Applies a position's own ticker/side/instrument/quantity/strike/
  // expiration in one go -- the same shape as the `prefill` prop, just
  // triggerable at any time (clicking a position badge) instead of only once
  // at mount.
  const applyPosition = (p: Position) => {
    const pf = positionToTradePrefill(p);
    setTicker(pf.ticker);
    setSide(pf.side);
    setInstrumentType(pf.instrumentType);
    setQuantity(String(pf.quantity));
    setStrike(pf.strike ?? "");
    setExpiration(pf.expiration ?? "");
  };

  // Live price context -- a quick glance, not a source of truth for the
  // trade itself. Debounced off the raw ticker so typing doesn't fire a
  // request per keystroke, then polled every few seconds while the ticket
  // stays open (finance-backend/docs/api-endpoints.md's quote endpoint). Silently
  // does without a price rather than showing an error -- this is a nice-to-
  // have readout, not something that should block or scare anyone off
  // submitting when no pricing provider is configured.
  const [debouncedTicker, setDebouncedTicker] = useState(ticker.trim().toUpperCase());
  useEffect(() => {
    const t = setTimeout(() => setDebouncedTicker(ticker.trim().toUpperCase()), QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [ticker]);

  const [quote, setQuote] = useState<Quote | null>(null);
  useEffect(() => {
    setQuote(null);
    if (!debouncedTicker) return;
    let cancelled = false;
    const fetchQuote = () => {
      getQuote(debouncedTicker)
        .then((q) => !cancelled && setQuote(q))
        .catch(() => !cancelled && setQuote(null));
    };
    fetchQuote();
    const interval = setInterval(fetchQuote, QUOTE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [debouncedTicker]);

  // Cheap date-only lookup to seed the expiration badges -- fetched once per
  // ticker instead of pulling a full chain just to find out what dates exist.
  const [expirations, setExpirations] = useState<string[]>([]);
  useEffect(() => {
    setExpirations([]);
    if (!isOption || !debouncedTicker) return;
    let cancelled = false;
    getOptionsExpirations(debouncedTicker)
      .then((dates) => !cancelled && setExpirations(dates))
      .catch(() => !cancelled && setExpirations([]));
    return () => {
      cancelled = true;
    };
  }, [isOption, debouncedTicker]);

  // Defaults to the nearest expiration once the list loads, or re-picks it
  // if switching tickers left the current selection off the new list --
  // otherwise the chain table has nothing to show until the user clicks a
  // date badge themselves.
  useEffect(() => {
    if (expirations.length > 0 && !expirations.includes(expiration)) {
      setExpiration(expirations[0]);
    }
  }, [expirations]);

  const [strikeCount, setStrikeCount] = useState(5);

  // Two-sided chain for the selected expiration, trimmed server-side to
  // `strikeCount` contracts per side closest to the money -- re-fetched on
  // the same poll cadence as the quote while the ticket stays open
  // (finance-backend/docs/api-endpoints.md's options-chain endpoint).
  const [chain, setChain] = useState<OptionsChain | null>(null);
  const [chainLoading, setChainLoading] = useState(false);
  useEffect(() => {
    setChain(null);
    if (!isOption || !debouncedTicker || !expiration) return;
    let cancelled = false;
    // Only the first fetch after ticker/expiration/strikeCount changes shows
    // "(loading…)" -- background polls on the interval below update the
    // table silently so it doesn't flicker every 5s.
    let first = true;
    const fetchChain = () => {
      if (first) setChainLoading(true);
      getOptionsChain(debouncedTicker, expiration, strikeCount)
        .then((c) => !cancelled && setChain(c))
        .catch(() => !cancelled && setChain(null))
        .finally(() => {
          if (!cancelled && first) setChainLoading(false);
          first = false;
        });
    };
    fetchChain();
    const interval = setInterval(fetchChain, QUOTE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isOption, debouncedTicker, expiration, strikeCount]);

  const chainRows = useMemo(() => buildChainRows(chain), [chain]);

  const contracts: OptionContract[] = !chain ? [] : instrumentType === "call" ? chain.calls : chain.puts;
  const selectedContract = contracts.find(
    (c) => String(c.strike_price) === String(Number(strike || NaN)) && c.expiration_date === expiration,
  );

  // Live underlying price, shown top-right next to Ticker/Side -- always the
  // ticker's own quote, whether trading the stock or an option on it. A
  // selected contract's own mid/bid/ask is already visible in the chain
  // table itself, so this readout doesn't switch to that -- showing the
  // same two numbers twice would be redundant.
  const priceReadout = quote?.last_price != null && (
    <span
      className={`trade-quote ${
        (quote.percent_change_pct ?? 0) > 0 ? "pnl-positive" : (quote.percent_change_pct ?? 0) < 0 ? "pnl-negative" : ""
      }`}
    >
      ${quote.last_price.toFixed(2)}
      {quote.percent_change_pct != null &&
        ` (${quote.percent_change_pct > 0 ? "+" : ""}${quote.percent_change_pct.toFixed(2)}%)`}
    </span>
  );

  // Picking either side of a chain row commits to that contract's own type
  // (call or put) -- there's no separate Call/Put badge, the table itself is
  // the instrument picker once "Options" is selected.
  const applyContract = (c: OptionContract) => {
    setInstrumentType(c.option_type);
    setStrike(String(c.strike_price));
    setExpiration(c.expiration_date);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    setRejection(null);
    setSubmitting(true);
    try {
      const body: NewTrade = {
        ticker: ticker.trim().toUpperCase(),
        side,
        instrument_type: instrumentType,
        quantity: Number(quantity),
        thesis,
        ...(isOption ? { strike, expiration } : {}),
        ...(limitPrice ? { limit_price: limitPrice } : {}),
        ...(isOpening && targetPrice ? { target_price: targetPrice } : {}),
        ...(isOpening && deadPrice ? { dead_price: deadPrice } : {}),
      };
      const trade = await submitTrade(competitorId, body);
      if (trade.status === "rejected") {
        setRejection(trade);
      } else {
        onFilled(trade);
      }
    } catch (err) {
      const fields = extractFieldErrors(err);
      if (Object.keys(fields).length > 0) {
        setFieldErrors(fields);
      } else {
        setError(extractGenericMessage(err, "Couldn't submit that trade."));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title={prefill ? `Close ${prefill.ticker}` : "New trade"} onClose={onClose} wide className="trade-modal-dialog">
      <form className="stack" onSubmit={handleSubmit}>
        {positions.length > 0 && (
          <div className="field">
            <label>Your positions</label>
            <div className="trade-badge-row">
              {positions.map((p, i) => (
                <button
                  type="button"
                  key={i}
                  className={`trade-badge${ticker.trim().toUpperCase() === p.ticker ? " is-selected" : ""}`}
                  onClick={() => applyPosition(p)}
                >
                  {positionBadgeLabel(p)}
                  <span className="trade-badge-sub">{positionBadgeSub(p)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="trade-compact-row">
          <div className="field" style={{ flex: "none", width: 100 }}>
            <label htmlFor="trade-ticker">Ticker</label>
            <input
              id="trade-ticker"
              className="input"
              value={ticker}
              onChange={(e) => setTicker(e.target.value)}
              placeholder="RKLB"
              autoCapitalize="characters"
              maxLength={TICKER_MAX_LENGTH}
              required
            />
            {fieldErrors.ticker?.map((msg) => (
              <p className="form-error" key={msg}>
                {msg}
              </p>
            ))}
          </div>

          <div className="field">
            <label>Side</label>
            <div className="trade-badge-row">
              {SIDE_OPTIONS.map((opt) => (
                <button
                  type="button"
                  key={opt.value}
                  className={`trade-badge${side === opt.value ? " is-selected" : ""}`}
                  onClick={() => setSide(opt.value)}
                  title={opt.label}
                >
                  {opt.short}
                </button>
              ))}
            </div>
          </div>

          {priceReadout && (
            <div className="field trade-price-readout-field">
              <label>&nbsp;</label>
              {priceReadout}
            </div>
          )}
        </div>

        <div className="trade-compact-row">
          <div className="field">
            <label>Instrument</label>
            <div className="trade-badge-row">
              <button
                type="button"
                className={`trade-badge${!isOption ? " is-selected" : ""}`}
                onClick={() => setInstrumentType("stock")}
              >
                Stock
              </button>
              <button
                type="button"
                className={`trade-badge${isOption ? " is-selected" : ""}`}
                onClick={() => {
                  if (!isOption) {
                    setInstrumentType("call");
                    // Contracts commonly get traded one at a time -- default
                    // to 1 rather than leaving Contracts blank, same as a
                    // real broker's ticket. Doesn't override a quantity
                    // that's already there (e.g. from a position badge).
                    setQuantity((q) => q || "1");
                  }
                }}
              >
                Options
              </button>
              {isOption && (
                <select
                  id="trade-strike-count"
                  className="input input-sm trade-strike-count"
                  value={strikeCount}
                  onChange={(e) => setStrikeCount(Number(e.target.value))}
                  title="Strikes per side"
                  aria-label="Strikes per side"
                >
                  {STRIKE_COUNT_OPTIONS.map((n) => (
                    <option key={n} value={n}>
                      {n} strikes
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>

          {isOption && (
            <div className="field">
              <label>Expiration</label>
              <div className="trade-badge-row trade-badge-row-nowrap">
                {expirations.slice(0, VISIBLE_EXPIRATIONS).map((date) => (
                  <button
                    type="button"
                    key={date}
                    className={`trade-badge trade-badge-sm${expiration === date ? " is-selected" : ""}`}
                    onClick={() => setExpiration(date)}
                  >
                    {formatExpirationShort(date)}
                  </button>
                ))}
                {expirations.length > VISIBLE_EXPIRATIONS && (
                  <select
                    className={`input input-sm trade-badge-more${
                      expirations.slice(VISIBLE_EXPIRATIONS).includes(expiration) ? " is-selected" : ""
                    }`}
                    value={expirations.slice(VISIBLE_EXPIRATIONS).includes(expiration) ? expiration : ""}
                    onChange={(e) => e.target.value && setExpiration(e.target.value)}
                  >
                    <option value="">More…</option>
                    {expirations.slice(VISIBLE_EXPIRATIONS).map((date) => (
                      <option key={date} value={date}>
                        {formatExpirationShort(date)}
                      </option>
                    ))}
                  </select>
                )}
                {expirations.length === 0 &&
                  (debouncedTicker ? (
                    <p className="text-muted">Loading expirations…</p>
                  ) : (
                    <p className="text-muted">Please enter a ticker.</p>
                  ))}
              </div>
            </div>
          )}
        </div>

        {isOption && (
          <div className="field">
            <label>Chain{chainLoading ? " (loading…)" : ""}</label>
            {chainRows.length > 0 ? (
              <div className="table-wrap trade-chain-scroll">
                <table className="table trade-chain-table">
                  <thead>
                    <tr>
                      <th colSpan={2}>Calls</th>
                      <th>Strike</th>
                      <th colSpan={2}>Puts</th>
                    </tr>
                    <tr>
                      <th>Bid</th>
                      <th>Ask</th>
                      <th></th>
                      <th>Bid</th>
                      <th>Ask</th>
                    </tr>
                  </thead>
                  <tbody>
                    {chainRows.map((row) => {
                      const callSelected = instrumentType === "call" && selectedContract === row.call;
                      const putSelected = instrumentType === "put" && selectedContract === row.put;
                      const callCellClass = `trade-chain-side${callSelected ? " is-selected" : ""}${row.call ? "" : " is-empty"}`;
                      const putCellClass = `trade-chain-side${putSelected ? " is-selected" : ""}${row.put ? "" : " is-empty"}`;
                      return (
                        <tr key={row.strike}>
                          <td className={callCellClass} onClick={() => row.call && applyContract(row.call)}>
                            {row.call?.bid ?? "—"}
                          </td>
                          <td className={callCellClass} onClick={() => row.call && applyContract(row.call)}>
                            {row.call?.ask ?? "—"}
                          </td>
                          <td className="trade-chain-strike">${row.strike}</td>
                          <td className={putCellClass} onClick={() => row.put && applyContract(row.put)}>
                            {row.put?.bid ?? "—"}
                          </td>
                          <td className={putCellClass} onClick={() => row.put && applyContract(row.put)}>
                            {row.put?.ask ?? "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              !chainLoading && <p className="text-muted">No live chain for this ticker/expiration -- enter strike/expiration manually.</p>
            )}
          </div>
        )}

        <div className="trade-compact-row">
          {isOption && (
            <div className="field">
              <label htmlFor="trade-option-type">Call/Put</label>
              <select
                id="trade-option-type"
                className="input input-sm"
                value={instrumentType === "put" ? "put" : "call"}
                onChange={(e) => setInstrumentType(e.target.value as InstrumentType)}
              >
                <option value="call">Call</option>
                <option value="put">Put</option>
              </select>
            </div>
          )}
          {isOption && (
            <div className="field">
              <label htmlFor="trade-strike">Strike</label>
              <input
                id="trade-strike"
                className="input input-sm"
                value={strike}
                onChange={(e) => setStrike(e.target.value)}
                required
              />
              {fieldErrors.strike?.map((msg) => (
                <p className="form-error" key={msg}>
                  {msg}
                </p>
              ))}
            </div>
          )}
          {isOption && (
            <div className="field">
              <label htmlFor="trade-expiration">Exp.</label>
              <input
                id="trade-expiration"
                className="input input-sm"
                type="date"
                value={expiration}
                onChange={(e) => setExpiration(e.target.value)}
                required
              />
              {fieldErrors.expiration?.map((msg) => (
                <p className="form-error" key={msg}>
                  {msg}
                </p>
              ))}
            </div>
          )}
          <div className="field">
            <label htmlFor="trade-quantity">{isOption ? "Contracts" : "Shares"}</label>
            <input
              id="trade-quantity"
              className="input input-sm"
              type="number"
              min="1"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              required
            />
            {fieldErrors.quantity?.map((msg) => (
              <p className="form-error" key={msg}>
                {msg}
              </p>
            ))}
          </div>

          <div className="field">
            <label htmlFor="trade-limit">Limit</label>
            <input
              id="trade-limit"
              className="input input-sm"
              value={limitPrice}
              onChange={(e) => setLimitPrice(e.target.value)}
              placeholder="Reject if worse"
            />
          </div>
        </div>

        <div className="field">
          <label htmlFor="trade-thesis">Thesis</label>
          <textarea id="trade-thesis" className="input" value={thesis} onChange={(e) => setThesis(e.target.value)} required />
          {fieldErrors.thesis?.map((msg) => (
            <p className="form-error" key={msg}>
              {msg}
            </p>
          ))}
        </div>

        <div className="field">
          <label>Target / dead price{isOpening ? " (optional)" : " -- opening trades only"}</label>
          <div className="trade-compact-row">
            <div className="field">
              <input
                id="trade-target"
                className="input input-sm"
                value={targetPrice}
                onChange={(e) => setTargetPrice(e.target.value)}
                placeholder="Take-profit"
                disabled={!isOpening}
              />
              {fieldErrors.target_price?.map((msg) => (
                <p className="form-error" key={msg}>
                  {msg}
                </p>
              ))}
            </div>
            <div className="field">
              <input
                id="trade-dead"
                className="input input-sm"
                value={deadPrice}
                onChange={(e) => setDeadPrice(e.target.value)}
                placeholder="Stop / invalidation"
                disabled={!isOpening}
              />
              {fieldErrors.dead_price?.map((msg) => (
                <p className="form-error" key={msg}>
                  {msg}
                </p>
              ))}
            </div>
          </div>
        </div>

        {rejection && (
          <p className="form-error">
            Rejected: {rejection.rejection_reason}
          </p>
        )}
        {error && <p className="form-error">{error}</p>}

        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? "Submitting…" : "Submit trade"}
        </button>
      </form>
    </Modal>
  );
}
