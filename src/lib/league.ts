// Client for the paper trading league (`league` app, docs/league-api.md):
// Competition -> Competitor -> Position/Trade. Decimal fields (cash_balance,
// account_value, fill_price, etc.) come back as strings, not JSON numbers --
// parse with Number() at render time rather than trusting float precision
// across the wire.

import { ApiError, apiFetch, parseJsonOrThrow } from "./api";

export type CompetitorKind = "ai" | "human";
export type InstrumentType = "stock" | "call" | "put";
export type TradeSide = "buy" | "sell" | "sell_to_open" | "buy_to_close";
export type TradeStatus = "filled" | "rejected";
export type WakeupStatus = "scheduled" | "completed" | "failed";
export type TurnTrigger = "scheduled_wakeup" | "manual";

export interface Competition {
  id: number;
  name: string;
  status: "upcoming" | "active" | "completed";
  starting_capital: string;
  max_position_pct: string;
  max_index_pct: string;
  cash_apy: string;
  index_tickers: string[];
  start_date: string;
  end_date: string;
  competitor_count: number;
}

export interface ScoreboardCompetitor {
  id: number;
  name: string;
  kind: CompetitorKind;
  cash_balance: string;
  account_value: string;
  total_return_pct: string;
  max_drawdown_pct: string;
}

export interface Scoreboard {
  competition: string;
  competitors: ScoreboardCompetitor[];
}

// AI-only fields (assistant_model/system_prompt) are absent entirely on a
// human row, not null -- optional here matches that.
export interface CompetitorSummary {
  id: number;
  name: string;
  kind: CompetitorKind;
  cash_balance: string;
  account_value: string;
  total_return_pct: string;
  user_email?: string;
  assistant_model?: string;
  system_prompt?: string;
}

export interface Position {
  instrument_type: InstrumentType;
  ticker: string;
  strike: string | null;
  expiration: string | null;
  quantity: number;
  is_short: boolean;
  avg_cost: string;
  opened_at: string;
}

export interface CompetitorDetail {
  id: number;
  name: string;
  kind: CompetitorKind;
  cash_balance: string;
  account_value: string;
  total_return_pct: string;
  positions: Position[];
}

export interface Trade {
  id: number;
  side: TradeSide;
  instrument_type: InstrumentType;
  ticker: string;
  strike: string | null;
  expiration: string | null;
  quantity: number;
  limit_price: string | null;
  fill_price: string | null;
  thesis: string;
  status: TradeStatus;
  rejection_reason: string;
  created_at: string;
}

export interface NewTrade {
  ticker: string;
  side: TradeSide;
  instrument_type: InstrumentType;
  quantity: number;
  strike?: string;
  expiration?: string;
  limit_price?: string;
  thesis: string;
}

export interface NewCompetitor {
  name: string;
  kind: CompetitorKind;
  model?: string;
  system_prompt?: string;
}

export interface Wakeup {
  id: number;
  run_at: string;
  reason: string;
  status: WakeupStatus;
  created_at: string;
  completed_at: string | null;
}

export interface TurnSummary {
  id: number;
  trigger: TurnTrigger;
  wakeup_id: number;
  tool_calls: string[];
  input_tokens: number;
  output_tokens: number;
  cost_usd: string;
  created_at: string;
}

// Assistant-role entries carry raw Anthropic content blocks verbatim
// (`block.model_dump()` server-side) -- text/tool_use/server_tool_use/
// web_search_tool_result today, potentially more later. Kept loose rather
// than a full union since new block types shouldn't need a frontend change
// to render "something happened here".
export interface TranscriptBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  [key: string]: unknown;
}

export interface TranscriptEntry {
  role: "user" | "assistant";
  text?: string;
  content?: TranscriptBlock[];
}

export interface TurnDetail extends TurnSummary {
  transcript: TranscriptEntry[];
}

export interface Scratchpad {
  content: string;
  updated_at: string | null;
}

export async function listCompetitions(): Promise<Competition[]> {
  const res = await apiFetch("/league/competitions/");
  return parseJsonOrThrow<Competition[]>(res);
}

export async function getScoreboard(competitionId: number): Promise<Scoreboard> {
  const res = await apiFetch(`/league/competitions/${competitionId}/scoreboard/`);
  return parseJsonOrThrow<Scoreboard>(res);
}

export async function listCompetitors(competitionId: number): Promise<CompetitorSummary[]> {
  const res = await apiFetch(`/league/competitions/${competitionId}/competitors/`);
  return parseJsonOrThrow<CompetitorSummary[]>(res);
}

export async function addCompetitor(competitionId: number, competitor: NewCompetitor): Promise<CompetitorSummary> {
  const res = await apiFetch(`/league/competitions/${competitionId}/competitors/`, {
    method: "POST",
    body: JSON.stringify(competitor),
  });
  return parseJsonOrThrow<CompetitorSummary>(res);
}

export async function getCompetitor(competitorId: number): Promise<CompetitorDetail> {
  const res = await apiFetch(`/league/competitors/${competitorId}/`);
  return parseJsonOrThrow<CompetitorDetail>(res);
}

export async function listTrades(competitorId: number): Promise<Trade[]> {
  const res = await apiFetch(`/league/competitors/${competitorId}/trades/`);
  return parseJsonOrThrow<Trade[]>(res);
}

/** Both a fill (201) and a rules-engine rejection (400) return the same
 *  trade-row shape (`status`/`rejection_reason` carry the outcome) -- only a
 *  genuine validation error (missing/unparseable field) lacks a `status` and
 *  should surface as a thrown error instead. */
export async function submitTrade(competitorId: number, trade: NewTrade): Promise<Trade> {
  const res = await apiFetch(`/league/competitors/${competitorId}/trades/`, {
    method: "POST",
    body: JSON.stringify(trade),
  });
  const data = await res.json().catch(() => ({}));
  if (data && typeof data === "object" && "status" in data) {
    return data as Trade;
  }
  throw new ApiError(res.status, data);
}

export async function listWakeups(competitorId: number): Promise<Wakeup[]> {
  const res = await apiFetch(`/league/competitors/${competitorId}/wakeups/`);
  return parseJsonOrThrow<Wakeup[]>(res);
}

export async function triggerWakeup(competitorId: number, reason?: string): Promise<Wakeup> {
  const res = await apiFetch(`/league/competitors/${competitorId}/wakeups/`, {
    method: "POST",
    body: JSON.stringify(reason ? { reason } : {}),
  });
  return parseJsonOrThrow<Wakeup>(res);
}

export async function listTurns(competitorId: number): Promise<TurnSummary[]> {
  const res = await apiFetch(`/league/competitors/${competitorId}/turns/`);
  return parseJsonOrThrow<TurnSummary[]>(res);
}

export async function getTurn(competitorId: number, turnId: number): Promise<TurnDetail> {
  const res = await apiFetch(`/league/competitors/${competitorId}/turns/${turnId}/`);
  return parseJsonOrThrow<TurnDetail>(res);
}

export async function getScratchpad(competitorId: number): Promise<Scratchpad> {
  const res = await apiFetch(`/league/competitors/${competitorId}/scratchpad/`);
  return parseJsonOrThrow<Scratchpad>(res);
}
