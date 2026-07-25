import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ApiError } from "../lib/api";
import { getCompanyReport, screenCompany, type CompanyReport, type FiscalSeries } from "../lib/companies";
import {
  formatDate,
  formatDateTime,
  formatMultiple,
  formatPercent,
  formatPrice,
  formatRunway,
  formatShares,
  formatUsd,
} from "../lib/format";
import { extractFieldErrors, extractGenericMessage, type FieldErrors } from "../lib/formErrors";
import {
  CLIP_CATEGORY_LABELS,
  CLIP_SOURCE_TYPE_LABELS,
  createClip,
  deleteClip,
  listClips,
  type ClipCategory,
  type ClipSourceType,
  type ResearchClip,
} from "../lib/clips";
import { getJournal, updateJournal, type CompanyJournal, type JournalPatch } from "../lib/journal";
import { realtime } from "../lib/ws";
import { Modal } from "../components/Modal";
import { InfoTip } from "../components/InfoTip";
import { DataFlag } from "../components/DataFlag";

const FINANCIAL_ROWS: { key: keyof CompanyReport["financials_by_fy"]; label: string; description: string }[] = [
  { key: "revenue", label: "Revenue", description: "Total revenue recognized for the fiscal year, as reported on the income statement." },
  { key: "gross_profit", label: "Gross profit", description: "Revenue minus cost of revenue (COGS) for the year." },
  { key: "net_loss", label: "Net income / (loss)", description: "Bottom-line profit or loss after all expenses, interest, and taxes." },
  { key: "operating_cash_flow", label: "Operating cash flow", description: "Cash generated or consumed by core business operations, per the cash flow statement." },
  { key: "capex", label: "Capex", description: "Cash spent on property, plant, and equipment during the year." },
  { key: "stock_based_comp", label: "Stock-based comp", description: "Non-cash compensation expense from equity awards granted to employees." },
  { key: "cash", label: "Cash & ST investments", description: "Cash, cash equivalents, and short-term investments on the balance sheet." },
  { key: "total_debt", label: "Total debt", description: "Sum of short- and long-term debt outstanding on the balance sheet." },
];

const DERIVED_SERIES_ROWS: {
  key: "gross_margin_pct_by_fy" | "fcf_by_fy" | "revenue_growth_pct_by_fy";
  label: string;
  format: (value: number) => string;
  description: string;
}[] = [
  { key: "gross_margin_pct_by_fy", label: "Gross margin", format: formatPercent, description: "Gross profit as a percentage of revenue." },
  { key: "fcf_by_fy", label: "Free cash flow", format: formatUsd, description: "Operating cash flow minus capex — cash left over after maintaining the business." },
  { key: "revenue_growth_pct_by_fy", label: "Revenue growth", format: formatPercent, description: "Year-over-year percentage change in revenue." },
];

const BALANCE_SHEET_SHARES_DESCRIPTION =
  "Shares outstanding as reported on the balance sheet / equity statement for that fiscal year.";

function seriesCell(series: FiscalSeries | undefined, fy: number, format: (value: number) => string): string {
  const value = series?.[String(fy)];
  return value === undefined ? "—" : format(value);
}

type JournalTextKey = "sells" | "wins" | "kills" | "checkpoint";

const JOURNAL_TEXTAREA_FIELDS: { key: "sells" | "wins" | "kills"; label: string }[] = [
  { key: "sells", label: "What they sell" },
  { key: "wins", label: "Why they win" },
  { key: "kills", label: "What kills them" },
];

/** Mode 3 deep-dive: the sells/wins/kills/checkpoint thesis row, autosaved
 *  field-by-field on blur (no explicit Save button). */
function JournalCard({ ticker, initial }: { ticker: string; initial: CompanyJournal }) {
  const [journal, setJournal] = useState(initial);
  const savedRef = useRef(initial);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  const commit = async (patch: JournalPatch) => {
    setSaveState("saving");
    setSaveError(null);
    try {
      const updated = await updateJournal(ticker, patch);
      setJournal(updated);
      savedRef.current = updated;
      setSaveState("saved");
    } catch (err) {
      setSaveState("error");
      setSaveError(extractGenericMessage(err, "Couldn't save."));
    }
  };

  const handleTextBlur = (key: JournalTextKey) => {
    const value = journal[key];
    if (value === savedRef.current[key]) return;
    commit({ [key]: value });
  };

  const handleDateBlur = () => {
    const value = journal.checkpoint_date;
    if (value === savedRef.current.checkpoint_date) return;
    commit({ checkpoint_date: value || null });
  };

  return (
    <div className="stack">
      <div className="page-head">
        <span className="text-muted">Autosaves on blur</span>
        {saveState === "saving" && <span className="text-muted">Saving…</span>}
        {saveState === "saved" && <span className="text-muted">Saved</span>}
        {saveState === "error" && <span className="form-error">{saveError}</span>}
      </div>
      <div className="stack">
        {JOURNAL_TEXTAREA_FIELDS.map(({ key, label }) => (
          <div className="field" key={key}>
            <label htmlFor={`journal-${key}`}>{label}</label>
            <textarea
              id={`journal-${key}`}
              className="input"
              value={journal[key]}
              onChange={(e) => setJournal({ ...journal, [key]: e.target.value })}
              onBlur={() => handleTextBlur(key)}
            />
          </div>
        ))}
        <div className="field">
          <label htmlFor="journal-checkpoint">Checkpoint</label>
          <input
            id="journal-checkpoint"
            className="input"
            value={journal.checkpoint}
            onChange={(e) => setJournal({ ...journal, checkpoint: e.target.value })}
            onBlur={() => handleTextBlur("checkpoint")}
          />
        </div>
        <div className="field">
          <label htmlFor="journal-checkpoint-date">Checkpoint date</label>
          <input
            id="journal-checkpoint-date"
            type="date"
            className="input"
            value={journal.checkpoint_date ?? ""}
            onChange={(e) => setJournal({ ...journal, checkpoint_date: e.target.value || null })}
            onBlur={handleDateBlur}
          />
        </div>
      </div>
    </div>
  );
}

/** Mode 3 deep-dive: paste-in research clips, grouped by the six deep-dive
 *  questions (or "context" for background material). Takes `clips` from its
 *  parent (rather than owning a local copy) so the tab-label count in
 *  `ResearchTabs` stays in sync with adds/deletes made here. */
function ClipsCard({
  ticker,
  clips,
  setClips,
}: {
  ticker: string;
  clips: ResearchClip[];
  setClips: (update: (prev: ResearchClip[]) => ResearchClip[]) => void;
}) {
  const [label, setLabel] = useState("");
  const [text, setText] = useState("");
  const [category, setCategory] = useState<ClipCategory>("context");
  const [sourceType, setSourceType] = useState<ClipSourceType>("other");
  const [source, setSource] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    setSubmitting(true);
    try {
      const clip = await createClip(ticker, {
        label,
        text,
        category,
        source_type: sourceType,
        source: source || undefined,
      });
      setClips((prev) => [clip, ...prev]);
      setLabel("");
      setText("");
      setSource("");
      setCategory("context");
      setSourceType("other");
    } catch (err) {
      const fields = extractFieldErrors(err);
      if (Object.keys(fields).length > 0) {
        setFieldErrors(fields);
      } else {
        setError(extractGenericMessage(err, "Couldn't save clip."));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!window.confirm("Delete this clip?")) return;
    try {
      await deleteClip(ticker, id);
      setClips((prev) => prev.filter((c) => c.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete clip.");
    }
  };

  return (
    <div className="stack">
      <form className="card elev-sm stack" onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="clip-label">Label</label>
          <input id="clip-label" className="input" value={label} onChange={(e) => setLabel(e.target.value)} required />
          {fieldErrors.label?.map((msg) => (
            <p className="form-error" key={msg}>
              {msg}
            </p>
          ))}
        </div>
        <div className="field">
          <label htmlFor="clip-text">Text</label>
          <textarea id="clip-text" className="input" value={text} onChange={(e) => setText(e.target.value)} required />
          {fieldErrors.text?.map((msg) => (
            <p className="form-error" key={msg}>
              {msg}
            </p>
          ))}
        </div>
        <div className="field">
          <label htmlFor="clip-category">Category</label>
          <select
            id="clip-category"
            className="input"
            value={category}
            onChange={(e) => setCategory(e.target.value as ClipCategory)}
          >
            {Object.entries(CLIP_CATEGORY_LABELS).map(([value, categoryLabel]) => (
              <option key={value} value={value}>
                {categoryLabel}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="clip-source-type">Source type</label>
          <select
            id="clip-source-type"
            className="input"
            value={sourceType}
            onChange={(e) => setSourceType(e.target.value as ClipSourceType)}
          >
            {Object.entries(CLIP_SOURCE_TYPE_LABELS).map(([value, sourceTypeLabel]) => (
              <option key={value} value={value}>
                {sourceTypeLabel}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="clip-source">Source</label>
          <input
            id="clip-source"
            className="input"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="10-Q Item 7, filed 2026-05-01"
          />
        </div>
        {error && <p className="form-error">{error}</p>}
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? "Saving…" : "Add clip"}
        </button>
      </form>

      {clips.length === 0 ? (
        <p className="text-muted">No clips saved yet.</p>
      ) : (
        <div className="stack">
          {clips.map((clip) => (
            <div className="card elev-sm" key={clip.id}>
              <div className="page-head">
                <strong>{clip.label}</strong>
                <span className="tag tag-outline">{CLIP_CATEGORY_LABELS[clip.category]}</span>
                <span className="tag tag-neutral">{CLIP_SOURCE_TYPE_LABELS[clip.source_type]}</span>
              </div>
              <p className="card-body">{clip.text}</p>
              {clip.source && <div className="card-meta">{clip.source}</div>}
              <div className="card-meta">{formatDate(clip.created_at)}</div>
              <button type="button" className="btn btn-ghost" onClick={() => handleDelete(clip.id)}>
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Mode 3 deep-dive section, shown once a ticker is tracked (report exists)
 *  regardless of whether it's been screened yet -- notes don't depend on
 *  the automated financial screen having run. */
function ResearchPanel({ ticker }: { ticker: string }) {
  const [journal, setJournal] = useState<CompanyJournal | null>(null);
  const [clips, setClips] = useState<ResearchClip[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    setJournal(null);
    setClips(null);
    setLoadError(null);
    let cancelled = false;
    Promise.all([getJournal(ticker), listClips(ticker)])
      .then(([j, c]) => {
        if (cancelled) return;
        setJournal(j);
        setClips(c);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Something went wrong.");
      });
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  if (loadError) {
    return (
      <div className="card elev-sm">
        <p className="form-error">{loadError}</p>
      </div>
    );
  }

  if (!journal || !clips) {
    return <p className="text-muted">Loading research…</p>;
  }

  return <ResearchTabs ticker={ticker} journal={journal} clips={clips} />;
}

function ResearchTabs({
  ticker,
  journal,
  clips: initialClips,
}: {
  ticker: string;
  journal: CompanyJournal;
  clips: ResearchClip[];
}) {
  const [tab, setTab] = useState<"journal" | "clips">("clips");
  const [clips, setClips] = useState(initialClips);

  return (
    <div className="stack">
      <div className="seg" role="tablist" aria-label="Research section">
        <label className="seg-opt">
          <input type="radio" name="research-tab" checked={tab === "clips"} onChange={() => setTab("clips")} />
          Clips{clips.length > 0 ? ` (${clips.length})` : ""}
        </label>
        <label className="seg-opt">
          <input type="radio" name="research-tab" checked={tab === "journal"} onChange={() => setTab("journal")} />
          Journal
        </label>
      </div>
      {/* Both stay mounted (just hidden) rather than switching on `tab`
          directly -- JournalCard holds its own edit/save state locally, and
          unmounting on tab-away would remount from the stale `initial`
          prop next time, silently reverting anything saved in between. */}
      <div style={{ display: tab === "journal" ? undefined : "none" }}>
        <JournalCard ticker={ticker} initial={journal} />
      </div>
      <div style={{ display: tab === "clips" ? undefined : "none" }}>
        <ClipsCard ticker={ticker} clips={clips} setClips={setClips} />
      </div>
    </div>
  );
}

export function ScreenerPage() {
  const { ticker: tickerParam } = useParams();
  const navigate = useNavigate();

  const [input, setInput] = useState(tickerParam ?? "");
  const [report, setReport] = useState<CompanyReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [screening, setScreening] = useState(false);
  // "queued" as soon as the POST is accepted, "running" once screen.progress
  // confirms the Celery task actually started -- both just drive button text.
  const [screenStatus, setScreenStatus] = useState<"queued" | "running" | null>(null);
  // True on a 404 -- ticker isn't tracked/known at all, so there's no report
  // to read a `screened` flag off of. Distinct from `report.screened ===
  // false`, which means the Company row exists but no screen has run yet.
  const [untracked, setUntracked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [researchOpen, setResearchOpen] = useState(false);

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

  // Screen outcomes arrive over the realtime socket, not the POST response
  // (which only queues the Celery task) -- see lib/companies.ts::screenCompany.
  useEffect(() => {
    if (!tickerParam) return;

    const offProgress = realtime.on("screen.progress", (message) => {
      if (message.ticker !== tickerParam) return;
      setScreenStatus("running");
    });
    const offComplete = realtime.on("screen.complete", (message) => {
      if (message.ticker !== tickerParam) return;
      setReport(message.report as CompanyReport);
      setUntracked(false);
      setScreening(false);
      setScreenStatus(null);
    });
    const offError = realtime.on("screen.error", (message) => {
      if (message.ticker !== tickerParam) return;
      setError(typeof message.message === "string" ? message.message : "Screen failed.");
      setScreening(false);
      setScreenStatus(null);
    });

    return () => {
      offProgress();
      offComplete();
      offError();
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
    setScreenStatus("queued");
    setError(null);
    try {
      await screenCompany(tickerParam, maxAgeDays);
    } catch (err) {
      setScreening(false);
      setScreenStatus(null);
      setError(err instanceof Error ? err.message : "Something went wrong.");
    }
  };

  // API returns fiscal_years ascending; the metric table reads left-to-right
  // as most-recent-first, so reverse it just for display.
  const displayFiscalYears = report ? [...report.fiscal_years].sort((a, b) => b - a) : [];

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

      {!loading && report && (
        <div className="page-actions">
          <button type="button" className="btn btn-primary" onClick={() => setResearchOpen(true)}>
            + Research
          </button>
        </div>
      )}

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
            {screening ? (screenStatus === "running" ? "Running…" : "Queued…") : "Run screen"}
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
              {screening ? (screenStatus === "running" ? "Running…" : "Queued…") : "Refresh (force)"}
            </button>
          </div>

          <div className="stat-grid">
            <div className="card elev-sm">
              <div className="card-kicker">Price</div>
              <div className="card-title">{formatPrice(report.price)}</div>
              <div className="card-meta">
                {report.price_queried_at ? `as of ${formatDateTime(report.price_queried_at)}` : "FMP_API_KEY not set"}
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
              <div className="card-kicker">
                Runway
                {report.derived.runway_status === "computed" && report.derived.fcf_approximated && (
                  <DataFlag text="Estimated from operating cash flow only -- capex not reported for this fiscal year." />
                )}
              </div>
              <div className="card-title">{formatRunway(report.derived.runway_status, report.derived.runway_years)}</div>
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
                  {displayFiscalYears.map((fy) => (
                    <th key={fy}>{fy}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {FINANCIAL_ROWS.map(({ key, label, description }) => {
                  const series = report.financials_by_fy[key];
                  return (
                    <tr key={key}>
                      <td>
                        {label}
                        <InfoTip text={description} />
                      </td>
                      {displayFiscalYears.map((fy) => (
                        <td key={fy}>{seriesCell(series, fy, formatUsd)}</td>
                      ))}
                    </tr>
                  );
                })}
                {DERIVED_SERIES_ROWS.map(({ key, label, format, description }) => {
                  const series = report.derived[key];
                  return (
                    <tr key={key}>
                      <td>
                        {label}
                        <InfoTip text={description} />
                      </td>
                      {displayFiscalYears.map((fy) => (
                        <td key={fy}>{seriesCell(series, fy, format)}</td>
                      ))}
                    </tr>
                  );
                })}
                <tr>
                  <td>
                    Balance-sheet shares
                    <InfoTip text={BALANCE_SHEET_SHARES_DESCRIPTION} />
                  </td>
                  {displayFiscalYears.map((fy) => (
                    <td key={fy}>{seriesCell(report.shares.balance_sheet_by_fy, fy, formatShares)}</td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>

          {report.filings.length > 0 && (
            <div className="card elev-sm">
              <div className="card-kicker">Filings</div>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Form</th>
                      <th>Filed</th>
                      <th>Period</th>
                      <th>Description</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.filings.map((filing) => (
                      <tr key={filing.accession_number}>
                        <td>{filing.form}</td>
                        <td>{formatDate(filing.filing_date)}</td>
                        <td>{formatDate(filing.report_date)}</td>
                        <td>{filing.description}</td>
                        <td>
                          <a href={filing.url} target="_blank" rel="noopener noreferrer">
                            View on EDGAR
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {researchOpen && report && (
        <Modal title={`${report.ticker} — Research`} onClose={() => setResearchOpen(false)} wide>
          <ResearchPanel ticker={report.ticker} />
        </Modal>
      )}
    </div>
  );
}
