// Client for the companies endpoints: the dashboard list (GET/POST
// /companies/), per-user status (PATCH .../status/), and the per-ticker
// screen/report pair (POST .../screen/, GET .../). All auth-required.

import { apiFetch, parseJsonOrThrow, ApiError } from "./api";

export type CompanyStatus = "pending" | "shortlisted" | "killed";
export type CompanyOrigin = "system" | "user";
/** "computed" -> runway_years holds a real figure. "profitable" -> FCF >= 0,
 *  runway isn't a meaningful question. "unknown" -> burning cash but missing
 *  the data to compute it. runway_years is null for both non-"computed" cases
 *  -- switch on this instead of inferring state from FCF's sign. */
export type RunwayStatus = "computed" | "profitable" | "unknown";

/** One row of the user's dashboard -- latest-fiscal-year summary only, not
 *  the full history (that's `CompanyReport`, below). */
export interface DashboardCompany {
  ticker: string;
  name: string;
  screened: boolean;
  price: number | null;
  market_cap: number | null;
  revenue_growth_pct: number | null;
  fcf: number | null;
  runway_years: number | null;
  runway_status: RunwayStatus;
  fcf_approximated: boolean;
  tripwire_triggered: boolean;
  updated_at: string;
  status: CompanyStatus;
  origin: CompanyOrigin;
  added_at: string;
}

/** The dashboard: every company this user tracks. Auto-provisions system
 *  defaults on a user's first-ever call. */
export async function listDashboard(): Promise<DashboardCompany[]> {
  const res = await apiFetch("/companies/");
  return parseJsonOrThrow<DashboardCompany[]>(res);
}

/** Adds a ticker to the user's dashboard. Idempotent -- an already-tracked
 *  ticker just returns its existing row. Does not trigger a screen. */
export async function addCompany(ticker: string): Promise<DashboardCompany> {
  const res = await apiFetch("/companies/", {
    method: "POST",
    body: JSON.stringify({ ticker }),
  });
  return parseJsonOrThrow<DashboardCompany>(res);
}

/** Sets this user's verdict for a tracked ticker. 404s if not tracked yet. */
export async function updateCompanyStatus(ticker: string, status: CompanyStatus): Promise<DashboardCompany> {
  const res = await apiFetch(`/companies/${encodeURIComponent(ticker)}/status/`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
  return parseJsonOrThrow<DashboardCompany>(res);
}

/** Fiscal year (as a string key, e.g. "2025") -> value. Years can be sparse
 *  -- not every field covers every year in `fiscal_years`. */
export type FiscalSeries = Record<string, number>;

export interface CoverPageShares {
  value: number;
  as_of: string;
  form: string;
}

export interface SharesFloatFmp {
  shares_outstanding: number;
  fmp_date: string;
  source: string;
}

export interface Tripwire {
  drift: number;
  triggered: boolean;
}

export interface Filing {
  form: string;
  filing_date: string;
  report_date: string;
  accession_number: string;
  url: string;
  description: string;
}

export interface CompanyReport {
  ticker: string;
  cik: number;
  name: string;
  screened: boolean;
  fiscal_years: number[];
  financials_by_fy: {
    revenue?: FiscalSeries;
    gross_profit?: FiscalSeries;
    net_loss?: FiscalSeries;
    operating_cash_flow?: FiscalSeries;
    capex?: FiscalSeries;
    stock_based_comp?: FiscalSeries;
    cash?: FiscalSeries;
    total_debt?: FiscalSeries;
  };
  derived: {
    gross_margin_pct_by_fy?: FiscalSeries;
    fcf_by_fy?: FiscalSeries;
    revenue_growth_pct_by_fy?: FiscalSeries;
    runway_years?: number | null;
    runway_status: RunwayStatus;
    fcf_approximated: boolean;
    ps_trailing?: number | null;
  };
  shares: {
    cover_page: CoverPageShares | null;
    balance_sheet_by_fy: FiscalSeries;
  };
  price: number | null;
  market_cap: number | null;
  price_queried_at: string | null;
  shares_float_fmp: SharesFloatFmp | null;
  tripwire: Tripwire;
  filings: Filing[];
}

/** Fast path: the latest cached report, no fetch triggered. Returns 200 with
 *  `screened: false` and empty/null financial fields for a tracked-but-
 *  never-screened ticker; callers should check that flag (not just catch a
 *  404) and offer `screenCompany` when it's false. */
export async function getCompanyReport(ticker: string): Promise<CompanyReport> {
  const res = await apiFetch(`/companies/${encodeURIComponent(ticker)}/`);
  return parseJsonOrThrow<CompanyReport>(res);
}

/** Queues Mode 1 (Screen) as a Celery task and returns as soon as it's
 *  enqueued (`202`) -- not once it's finished. Pass 0 to force a full
 *  refresh. The outcome arrives later over the realtime socket as
 *  `screen.progress` then exactly one of `screen.complete` / `screen.error`
 *  for this ticker (see lib/ws.ts and finance-backend/docs/websockets.md); this call only
 *  reports whether the ticker was accepted for screening. */
export async function screenCompany(ticker: string, maxAgeDays?: number): Promise<void> {
  const res = await apiFetch(`/companies/${encodeURIComponent(ticker)}/screen/`, {
    method: "POST",
    body: JSON.stringify(maxAgeDays !== undefined ? { max_age_days: maxAgeDays } : {}),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body);
  }
}

/** A quick live quote for any ticker -- no tracked `Company` row required,
 *  unlike getCompanyReport. Meant to be polled while a trade ticket is open
 *  (finance-backend/docs/api-endpoints.md) for a "here's the current price" readout, not
 *  stored or cached. Exact field set matches whichever pricing provider is
 *  active; last_price is null (not an error) for a ticker the provider
 *  doesn't recognize. */
export interface Quote {
  symbol: string;
  company_name: string | null;
  exchange: string | null;
  market_status: string | null;
  last_price: number | null;
  net_change: number | null;
  percent_change_pct: number | null;
  is_real_time: boolean;
  last_trade_timestamp: string | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  average_volume: number | null;
  close: number | null;
  after_hours: number | null;
  fifty_two_week_range: string | null;
  day_range: string | null;
}

/** SteadyAPI-only; Tradier ignores it and auto-detects the asset class. */
export type QuoteAssetClass = "STOCKS" | "ETF" | "MUTUALFUNDS" | "FUTURES";

export async function getQuote(ticker: string, assetClass?: QuoteAssetClass): Promise<Quote> {
  const qs = assetClass ? `?asset_class=${encodeURIComponent(assetClass)}` : "";
  const res = await apiFetch(`/companies/${encodeURIComponent(ticker)}/quote/${qs}`);
  return parseJsonOrThrow<Quote>(res);
}

export interface OptionContract {
  symbol: string;
  base_symbol: string;
  strike_price: number;
  expiration_date: string;
  moneyness_pct: number | null;
  bid: number | null;
  mid: number | null;
  ask: number | null;
  last: number | null;
  volume: number | null;
  open_interest: number | null;
  implied_volatility_pct: number | null;
  delta: number | null;
  option_type: "call" | "put";
}

export interface OptionsChain {
  expirations: string[];
  calls: OptionContract[];
  puts: OptionContract[];
}

/** Just the expiration dates for a ticker's options -- a cheap call meant to
 *  seed a date picker before committing to a full chain fetch below. Always
 *  one flat, sorted YYYY-MM-DD list regardless of provider. */
export async function getOptionsExpirations(ticker: string): Promise<string[]> {
  const res = await apiFetch(`/companies/${encodeURIComponent(ticker)}/options-expirations/`);
  const data = await parseJsonOrThrow<{ expirations: string[] }>(res);
  return data.expirations;
}

/** Live options chain for a ticker, same no-tracking-required contract as
 *  getQuote. Omitting `expiration` gets the provider's own nearest/next
 *  expiration. `strikes` trims calls/puts to the N contracts on each side
 *  closest to the money (ranked by |moneyness_pct|) -- strongly recommended
 *  for any UI table, since an unfiltered chain can be 100+ strikes per side;
 *  omit it only to build your own strike-range picker over the full chain.
 *  Empty calls/puts (no listed options, or no expiration on/after today) is
 *  a valid 200, not an error. */
export async function getOptionsChain(ticker: string, expiration?: string, strikes?: number): Promise<OptionsChain> {
  const params = new URLSearchParams();
  if (expiration) params.set("expiration", expiration);
  if (strikes) params.set("strikes", String(strikes));
  const qs = params.toString() ? `?${params.toString()}` : "";
  const res = await apiFetch(`/companies/${encodeURIComponent(ticker)}/options-chain/${qs}`);
  return parseJsonOrThrow<OptionsChain>(res);
}
