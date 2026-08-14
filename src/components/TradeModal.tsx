// Submit a trade for the user's own human competitor
// (POST /api/league/competitors/{id}/trades/). A rejection isn't a form
// error -- it's a normal 400 carrying a full trade row with `rejection_reason`
// (the rules engine's human-readable explanation), rendered inline so the
// user can see exactly why and adjust, same as a real broker's reject message.

import { useState, type FormEvent } from "react";
import { Modal } from "./Modal";
import { submitTrade, type InstrumentType, type NewTrade, type Trade, type TradeSide } from "../lib/league";
import { extractFieldErrors, extractGenericMessage, type FieldErrors } from "../lib/formErrors";

const SIDE_OPTIONS: { value: TradeSide; label: string }[] = [
  { value: "buy", label: "Buy (open/add)" },
  { value: "sell", label: "Sell (close/reduce)" },
  { value: "sell_to_open", label: "Sell to open (covered call / cash-covered put)" },
  { value: "buy_to_close", label: "Buy to close" },
];

const INSTRUMENT_OPTIONS: { value: InstrumentType; label: string }[] = [
  { value: "stock", label: "Stock" },
  { value: "call", label: "Call" },
  { value: "put", label: "Put" },
];

export function TradeModal({
  competitorId,
  onClose,
  onFilled,
}: {
  competitorId: number;
  onClose: () => void;
  onFilled: (trade: Trade) => void;
}) {
  const [ticker, setTicker] = useState("");
  const [side, setSide] = useState<TradeSide>("buy");
  const [instrumentType, setInstrumentType] = useState<InstrumentType>("stock");
  const [quantity, setQuantity] = useState("");
  const [strike, setStrike] = useState("");
  const [expiration, setExpiration] = useState("");
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
      if (trade.status === "filled") {
        onFilled(trade);
      } else {
        setRejection(trade);
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
    <Modal title="New trade" onClose={onClose}>
      <form className="stack" onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="trade-ticker">Ticker</label>
          <input
            id="trade-ticker"
            className="input"
            value={ticker}
            onChange={(e) => setTicker(e.target.value)}
            placeholder="RKLB"
            autoCapitalize="characters"
            required
          />
          {fieldErrors.ticker?.map((msg) => (
            <p className="form-error" key={msg}>
              {msg}
            </p>
          ))}
        </div>

        <div className="field">
          <label htmlFor="trade-side">Side</label>
          <select id="trade-side" className="input" value={side} onChange={(e) => setSide(e.target.value as TradeSide)}>
            {SIDE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="trade-instrument">Instrument</label>
          <select
            id="trade-instrument"
            className="input"
            value={instrumentType}
            onChange={(e) => setInstrumentType(e.target.value as InstrumentType)}
          >
            {INSTRUMENT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="trade-quantity">{isOption ? "Contracts" : "Shares"}</label>
          <input
            id="trade-quantity"
            className="input"
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

        {isOption && (
          <>
            <div className="field">
              <label htmlFor="trade-strike">Strike</label>
              <input id="trade-strike" className="input" value={strike} onChange={(e) => setStrike(e.target.value)} required />
              {fieldErrors.strike?.map((msg) => (
                <p className="form-error" key={msg}>
                  {msg}
                </p>
              ))}
            </div>
            <div className="field">
              <label htmlFor="trade-expiration">Expiration</label>
              <input
                id="trade-expiration"
                className="input"
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
          </>
        )}

        <div className="field">
          <label htmlFor="trade-limit">Limit price (optional)</label>
          <input
            id="trade-limit"
            className="input"
            value={limitPrice}
            onChange={(e) => setLimitPrice(e.target.value)}
            placeholder="Reject if the live fill is worse than this"
          />
        </div>

        {isOpening && (
          <>
            <div className="field">
              <label htmlFor="trade-target">Target price (optional)</label>
              <input
                id="trade-target"
                className="input"
                value={targetPrice}
                onChange={(e) => setTargetPrice(e.target.value)}
                placeholder="Take-profit level -- informational, revisable anytime"
              />
              {fieldErrors.target_price?.map((msg) => (
                <p className="form-error" key={msg}>
                  {msg}
                </p>
              ))}
            </div>
            <div className="field">
              <label htmlFor="trade-dead">Dead price (optional)</label>
              <input
                id="trade-dead"
                className="input"
                value={deadPrice}
                onChange={(e) => setDeadPrice(e.target.value)}
                placeholder="Invalidation/stop level -- informational, revisable anytime"
              />
              {fieldErrors.dead_price?.map((msg) => (
                <p className="form-error" key={msg}>
                  {msg}
                </p>
              ))}
            </div>
          </>
        )}

        <div className="field">
          <label htmlFor="trade-thesis">Thesis</label>
          <textarea id="trade-thesis" className="input" value={thesis} onChange={(e) => setThesis(e.target.value)} required />
          {fieldErrors.thesis?.map((msg) => (
            <p className="form-error" key={msg}>
              {msg}
            </p>
          ))}
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
