// Client for the companies endpoints: the dashboard list (GET/POST
// /companies/), per-user status (PATCH .../status/), and the per-ticker
// screen/report pair (POST .../screen/, GET .../). All auth-required.

import { apiFetch, parseJsonOrThrow } from "./api";

export type CompanyStatus = "pending" | "shortlisted" | "killed";
export type CompanyOrigin = "system" | "user";

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

/** Runs Mode 1 (Screen): fetches fresh EDGAR/FMP data (reusing anything
 *  cached under `maxAgeDays` old) and returns the report. Pass 0 to force a
 *  full refresh. */
export async function screenCompany(ticker: string, maxAgeDays?: number): Promise<CompanyReport> {
  const res = await apiFetch(`/companies/${encodeURIComponent(ticker)}/screen/`, {
    method: "POST",
    body: JSON.stringify(maxAgeDays !== undefined ? { max_age_days: maxAgeDays } : {}),
  });
  return parseJsonOrThrow<CompanyReport>(res);
}
