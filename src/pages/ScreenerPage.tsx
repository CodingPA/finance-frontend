import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ApiError } from "../lib/api";
import { getCompanyReport, screenCompany, type CompanyReport, type FiscalSeries } from "../lib/companies";
import { formatDate, formatMultiple, formatPercent, formatPrice, formatShares, formatUsd, formatYears } from "../lib/format";

const FINANCIAL_ROWS: { key: keyof CompanyReport["financials_by_fy"]; label: string }[] = [
  { key: "revenue", label: "Revenue" },
  { key: "gross_profit", label: "Gross profit" },
  { key: "net_loss", label: "Net income / (loss)" },
  { key: "operating_cash_flow", label: "Operating cash flow" },
  { key: "capex", label: "Capex" },
  { key: "stock_based_comp", label: "Stock-based comp" },
  { key: "cash", label: "Cash & ST investments" },
  { key: "total_debt", label: "Total debt" },
];

const DERIVED_SERIES_ROWS: {
  key: "gross_margin_pct_by_fy" | "fcf_by_fy" | "revenue_growth_pct_by_fy";
  label: string;
  format: (value: number) => string;
}[] = [
  { key: "gross_margin_pct_by_fy", label: "Gross margin", format: formatPercent },
  { key: "fcf_by_fy", label: "Free cash flow", format: formatUsd },
  { key: "revenue_growth_pct_by_fy", label: "Revenue growth", format: formatPercent },
];

function seriesCell(series: FiscalSeries | undefined, fy: number, format: (value: number) => string): string {
  const value = series?.[String(fy)];
  return value === undefined ? "—" : format(value);
}

export function ScreenerPage() {
  const { ticker: tickerParam } = useParams();
  const navigate = useNavigate();

  const [input, setInput] = useState(tickerParam ?? "");
  const [report, setReport] = useState<CompanyReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [screening, setScreening] = useState(false);
  // True on a 404 -- ticker isn't tracked/known at all, so there's no report
  // to read a `screened` flag off of. Distinct from `report.screened ===
  // false`, which means the Company row exists but no screen has run yet.
  const [untracked, setUntracked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setInput(tickerParam ?? "");
    setReport(null);
    setUntracked(false);
    setError(null);
    if (!tickerParam) return;

    let cancelled = false;
    setLoading(true);
    getCompanyReport(tickerParam)
      .then((data) => {
        if (!cancelled) setReport(data);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setUntracked(true);
        } else {
          setError(err instanceof Error ? err.message : "Something went wrong.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [tickerParam]);

  const handleSearch = (e: FormEvent) => {
    e.preventDefault();
    const normalized = input.trim().toUpperCase();
    if (!normalized) return;
    navigate(`/screen/${normalized}`);
  };

  const runScreen = async (maxAgeDays?: number) => {
    if (!tickerParam) return;
    setScreening(true);
    setError(null);
    try {
      const data = await screenCompany(tickerParam, maxAgeDays);
      setReport(data);
      setUntracked(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setScreening(false);
    }
  };

  return (
    <div className="page">
      <h2>Screener</h2>

      <form className="screener-search" onSubmit={handleSearch}>
        <div className="field">
          <label htmlFor="ticker">Ticker</label>
          <input
            id="ticker"
            className="input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="RKLB"
            autoCapitalize="characters"
          />
        </div>
        <button type="submit" className="btn btn-primary">
          Look up
        </button>
      </form>

      {loading && <p className="text-muted">Loading {tickerParam}…</p>}
      {error && <p className="form-error">{error}</p>}

      {!loading && tickerParam && (untracked || (report && !report.screened)) && (
        <div className="card elev-sm">
          {report ? (
            <div className="page-head">
              <h3>{report.name}</h3>
              <span className="tag tag-outline">{report.ticker}</span>
            </div>
          ) : null}
          <p className="card-body">{report ? report.ticker : tickerParam} hasn't been screened yet.</p>
          <button type="button" className="btn btn-primary" onClick={() => runScreen()} disabled={screening}>
            {screening ? "Screening…" : "Run screen"}
          </button>
        </div>
      )}

      {!loading && report && report.screened && (
        <>
          <div className="page-head">
            <h3>{report.name}</h3>
            <span className="tag tag-outline">{report.ticker}</span>
            <span className="text-muted">CIK {report.cik}</span>
          </div>

          <div className="page-actions">
            <button type="button" className="btn btn-secondary" onClick={() => runScreen(0)} disabled={screening}>
              {screening ? "Refreshing…" : "Refresh (force)"}
            </button>
          </div>

          <div className="stat-grid">
            <div className="card elev-sm">
              <div className="card-kicker">Price</div>
              <div className="card-title">{formatPrice(report.price)}</div>
              <div className="card-meta">
                {report.price_queried_at ? `as of ${formatDate(report.price_queried_at)}` : "FMP_API_KEY not set"}
              </div>
            </div>
            <div className="card elev-sm">
              <div className="card-kicker">Market cap</div>
              <div className="card-title">{formatUsd(report.market_cap)}</div>
            </div>
            <div className="card elev-sm">
              <div className="card-kicker">P/S trailing</div>
              <div className="card-title">{formatMultiple(report.derived.ps_trailing)}</div>
            </div>
            <div className="card elev-sm">
              <div className="card-kicker">Runway</div>
              <div className="card-title">{formatYears(report.derived.runway_years)}</div>
            </div>
            <div className="card elev-sm">
              <div className="card-kicker">Cover-page shares</div>
              <div className="card-title">
                {report.shares.cover_page ? formatShares(report.shares.cover_page.value) : "—"}
              </div>
              <div className="card-meta">
                {report.shares.cover_page
                  ? `${report.shares.cover_page.form}, as of ${formatDate(report.shares.cover_page.as_of)}`
                  : ""}
              </div>
            </div>
            <div className="card elev-sm">
              <div className="card-kicker">Tripwire</div>
              <div className="card-title">
                <span className={`tag ${report.tripwire.triggered ? "tag-accent" : "tag-neutral"}`}>
                  {report.tripwire.triggered ? "Triggered" : "Clean"}
                </span>
              </div>
              <div className="card-meta">drift {(report.tripwire.drift * 100).toFixed(4)}%</div>
            </div>
          </div>

          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Metric</th>
                  {report.fiscal_years.map((fy) => (
                    <th key={fy}>{fy}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {FINANCIAL_ROWS.map(({ key, label }) => {
                  const series = report.financials_by_fy[key];
                  return (
                    <tr key={key}>
                      <td>{label}</td>
                      {report.fiscal_years.map((fy) => (
                        <td key={fy}>{seriesCell(series, fy, formatUsd)}</td>
                      ))}
                    </tr>
                  );
                })}
                {DERIVED_SERIES_ROWS.map(({ key, label, format }) => {
                  const series = report.derived[key];
                  return (
                    <tr key={key}>
                      <td>{label}</td>
                      {report.fiscal_years.map((fy) => (
                        <td key={fy}>{seriesCell(series, fy, format)}</td>
                      ))}
                    </tr>
                  );
                })}
                <tr>
                  <td>Balance-sheet shares</td>
                  {report.fiscal_years.map((fy) => (
                    <td key={fy}>{seriesCell(report.shares.balance_sheet_by_fy, fy, formatShares)}</td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
