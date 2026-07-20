import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { ApiError } from "../lib/api";
import {
  addCompany,
  listDashboard,
  updateCompanyStatus,
  type CompanyStatus,
  type DashboardCompany,
} from "../lib/companies";
import { formatDate, formatPercent, formatPrice, formatUsd, formatYears } from "../lib/format";

const STATUS_OPTIONS: { value: CompanyStatus; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "shortlisted", label: "Shortlist" },
  { value: "killed", label: "Kill" },
];

export function DashboardPage() {
  const { user } = useAuth();

  const [companies, setCompanies] = useState<DashboardCompany[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [tickerInput, setTickerInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listDashboard()
      .then((rows) => {
        if (!cancelled) setCompanies(rows);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Something went wrong.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAdd = async (e: FormEvent) => {
    e.preventDefault();
    const ticker = tickerInput.trim().toUpperCase();
    if (!ticker) return;
    setAdding(true);
    setAddError(null);
    try {
      // POST /companies/ is idempotent -- an already-tracked ticker just
      // comes back as its existing row, so replace-then-append is safe.
      const row = await addCompany(ticker);
      setCompanies((prev) => [...prev.filter((c) => c.ticker !== row.ticker), row].sort((a, b) => a.ticker.localeCompare(b.ticker)));
      setTickerInput("");
    } catch (err) {
      setAddError(err instanceof ApiError ? err.message : "Couldn't add that ticker.");
    } finally {
      setAdding(false);
    }
  };

  const handleStatusChange = async (ticker: string, status: CompanyStatus) => {
    const previous = companies;
    setCompanies((prev) => prev.map((c) => (c.ticker === ticker ? { ...c, status } : c)));
    try {
      await updateCompanyStatus(ticker, status);
    } catch {
      setCompanies(previous);
    }
  };

  return (
    <div className="page">
      <h2>Welcome{user?.name ? `, ${user.name}` : ""}.</h2>
      <p className="text-muted">Signed in as {user?.email}.</p>

      <form className="screener-search" onSubmit={handleAdd}>
        <div className="field">
          <label htmlFor="add-ticker">Add ticker</label>
          <input
            id="add-ticker"
            className="input"
            value={tickerInput}
            onChange={(e) => setTickerInput(e.target.value)}
            placeholder="RKLB"
            autoCapitalize="characters"
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={adding}>
          {adding ? "Adding…" : "Add"}
        </button>
      </form>
      {addError && <p className="form-error">{addError}</p>}

      {loading && <p className="text-muted">Loading dashboard…</p>}
      {error && <p className="form-error">{error}</p>}
      {!loading && !error && companies.length === 0 && <p className="text-muted">No companies tracked yet.</p>}

      {!loading && companies.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Name</th>
                <th>Origin</th>
                <th>Status</th>
                <th>Price</th>
                <th>Market cap</th>
                <th>Rev growth</th>
                <th>FCF</th>
                <th>Runway</th>
                <th>Tripwire</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {companies.map((c) => (
                <tr key={c.ticker}>
                  <td>
                    <Link to={`/screen/${c.ticker}`}>{c.ticker}</Link>
                  </td>
                  <td>{c.name}</td>
                  <td>
                    <span className={`tag ${c.origin === "user" ? "tag-outline" : "tag-neutral"}`}>
                      {c.origin === "user" ? "MINE" : "SYS"}
                    </span>
                  </td>
                  <td>
                    <div className="seg" role="radiogroup" aria-label={`${c.ticker} status`}>
                      {STATUS_OPTIONS.map((opt) => (
                        <label className="seg-opt" key={opt.value}>
                          <input
                            type="radio"
                            name={`status-${c.ticker}`}
                            checked={c.status === opt.value}
                            onChange={() => handleStatusChange(c.ticker, opt.value)}
                          />
                          {opt.label}
                        </label>
                      ))}
                    </div>
                  </td>
                  <td>{formatPrice(c.price)}</td>
                  <td>{formatUsd(c.market_cap)}</td>
                  <td>{formatPercent(c.revenue_growth_pct)}</td>
                  <td>{formatUsd(c.fcf)}</td>
                  <td>{formatYears(c.runway_years)}</td>
                  <td>
                    <span className={`tag ${c.tripwire_triggered ? "tag-accent" : "tag-neutral"}`}>
                      {c.tripwire_triggered ? "Triggered" : "Clean"}
                    </span>
                  </td>
                  <td>{formatDate(c.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
