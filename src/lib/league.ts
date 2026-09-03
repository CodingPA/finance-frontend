// Client for the paper trading league (`league` app, finance-backend/docs/league-api.md):
// Competition -> Competitor -> Position/Trade. Decimal fields (cash_balance,
// account_value, fill_price, etc.) come back as strings, not JSON numbers --
// parse with Number() at render time rather than trusting float precision
// across the wire.

import { ApiError, apiFetch, parseJsonOrThrow } from "./api";

export type CompetitorKind = "ai" | "human";
export type ModelProvider = "anthropic" | "openai" | "gemini";
export type InstrumentType = "stock" | "call" | "put";
export type TradeSide = "buy" | "sell" | "sell_to_open" | "buy_to_close";
// "pending" only occurs for a competition with restrict_after_hours_trading
// turned on (opt-in, most competitions don't) -- the order was accepted
// while the market's closed and is queued to resolve at the next open.
// "cancelled" is a human pulling their own still-pending order via
// cancelTrade() before it resolves -- cheap and safe, since a pending order
// never touched cash/positions in the first place. Same trade id transitions
// pending -> filled, pending -> rejected, or pending -> cancelled in place;
// it is never replaced by a new row, so anything merging a league.trade push
// into a trade list must update by id rather than assume every push is a
// new trade.
export type TradeStatus = "pending" | "filled" | "rejected" | "cancelled";

export const TRADE_STATUS_LABELS: Record<TradeStatus, string> = {
  pending: "queued",
  filled: "filled",
  rejected: "rejected",
  cancelled: "cancelled",
};

/** Tag styling for a trade's status -- pending gets its own outline variant
 *  rather than sharing rejected's neutral tag, since it's neither a success
 *  nor a failure, just deferred to the next market open. Cancelled shares
 *  rejected's neutral tag -- both are "this order didn't happen", just for
 *  different reasons. */
export function tradeStatusTagClass(status: TradeStatus): string {
  if (status === "filled") return "tag-accent";
  if (status === "pending") return "tag-outline";
  return "tag-neutral";
}
export type WakeupStatus = "scheduled" | "completed" | "failed";
export type TurnTrigger = "scheduled_wakeup" | "manual" | "forced_checkin";

// "" on a filled trade, or on a rejected trade predating this field
// (finance-backend/docs/league-api.md: excluded from GET .../scoreboard/'s rejected_trades
// breakdown rather than folded into a misleading bucket).
export type RejectionCode =
  | "price_limit"
  | "position_cap"
  | "index_cap"
  | "insufficient_cash"
  | "insufficient_holdings"
  | "insufficient_collateral"
  | "market_unavailable"
  | "invalid_request"
  | "";

export const REJECTION_CODE_LABELS: Record<Exclude<RejectionCode, "">, string> = {
  price_limit: "price limits",
  position_cap: "position cap",
  index_cap: "index cap",
  insufficient_cash: "insufficient cash",
  insufficient_holdings: "insufficient holdings",
  insufficient_collateral: "insufficient collateral",
  market_unavailable: "market unavailable",
  invalid_request: "invalid requests",
};

export const TURN_TRIGGER_LABELS: Record<TurnTrigger, string> = {
  scheduled_wakeup: "Self-scheduled",
  manual: "Manual",
  forced_checkin: "Forced check-in",
};

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

// filled_trades_count/api_cost_usd/last_woke_at: null/0 for a competitor
// that's never filled a trade or woken -- always true for a human
// competitor, and for an AI that hasn't run yet.
//
// Budget fields (AI competitors only -- absent entirely, not null, on a
// human row, same convention as CompetitorSummary's assistant_model/
// system_prompt): total_budget_usd/weekly_budget_usd are operator-set caps,
// null meaning "not configured" rather than zero or unlimited-but-tracked.
// total_budget_usd is a hard cap checked between wake-ups (not mid-call),
// so api_cost_usd can end up slightly over it before the pause takes
// effect -- clamp a progress bar at 100% rather than treating that as an
// error. weekly_budget_usd is advisory only (nothing is enforced against
// it), for the current Mon 00:00 ET -> next Mon 00:00 ET trading week.
// week_spent_usd/today_spent_usd are plain spend telemetry -- real numbers
// (or "0") for any AI competitor that's made at least one call, independent
// of whether a budget is configured at all.
export interface ScoreboardCompetitor {
  id: number;
  name: string;
  kind: CompetitorKind;
  cash_balance: string;
  account_value: string;
  total_return_pct: string;
  max_drawdown_pct: string;
  filled_trades_count: number;
  api_cost_usd: string | null;
  last_woke_at: string | null;
  total_budget_usd?: string | null;
  weekly_budget_usd?: string | null;
  week_spent_usd?: string | null;
  today_spent_usd?: string | null;
}

/** Competition-wide rejected-trade counts by rejection_code, most-common
 *  first (finance-backend/docs/league-api.md) -- excludes trades rejected before
 *  rejection_code existed rather than folding them into a misleading
 *  bucket, so this undercounts a competition's full rejection history. */
export interface RejectedTradesBreakdown {
  reason: RejectionCode;
  count: number;
}

export interface Scoreboard {
  competition: string;
  competitors: ScoreboardCompetitor[];
  rejected_trades: RejectedTradesBreakdown[];
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
  filled_trades_count: number;
  api_cost_usd: string | null;
  last_woke_at: string | null;
  // Budget fields (AI competitors only) -- see ScoreboardCompetitor's comment.
  total_budget_usd?: string | null;
  weekly_budget_usd?: string | null;
  week_spent_usd?: string | null;
  today_spent_usd?: string | null;
  user_email?: string;
  assistant_model?: string;
  system_prompt?: string;
  // Cosmetic-only identity, freeform and backend-unvalidated (max 7/8 chars
  // respectively) -- "" for a competitor that never set one (e.g. a custom
  // AI persona that isn't one of the seeded built-ins), not absent, so
  // competitorColor()/competitorAvatar() below are the right way to read
  // these rather than checking truthiness inline.
  color?: string;
  avatar?: string;
}

/** spent / limit as a 0-100 percent, clamped -- null limit (not configured)
 *  or null spent both mean "nothing to show", not 0%, since the hard-cap
 *  check runs between wake-ups rather than mid-call and can leave spend
 *  slightly over limit (a few cents) before the pause takes effect. */
export function budgetProgressPct(spent: string | null | undefined, limit: string | null | undefined): number | null {
  if (limit === null || limit === undefined || spent === null || spent === undefined) return null;
  const limitNum = Number(limit);
  if (!(limitNum > 0)) return null;
  return Math.min(100, Math.max(0, (Number(spent) / limitNum) * 100));
}

export const DEFAULT_COMPETITOR_COLOR = "var(--color-neutral-400)";
export const DEFAULT_COMPETITOR_AVATAR = "\u{1F916}"; // 🤖

/** "" (unset) falls back to a neutral default rather than rendering blank. */
export function competitorColor(color?: string): string {
  return color && color.trim() ? color : DEFAULT_COMPETITOR_COLOR;
}

export function competitorAvatar(avatar?: string): string {
  return avatar && avatar.trim() ? avatar : DEFAULT_COMPETITOR_AVATAR;
}

export interface Position {
  id: number;
  instrument_type: InstrumentType;
  ticker: string;
  strike: string | null;
  expiration: string | null;
  quantity: number;
  is_short: boolean;
  avg_cost: string;
  // Live unit price (last sale for stock, bid for options) and sign-aware
  // total market value (negative for the short leg of a covered call/put) --
  // same convention account_value already uses.
  current_price: string;
  current_value: string;
  // Timestamp of the TickerSnapshot current_price/current_value came from --
  // null when there's no snapshot yet and the mark fell back to avg_cost
  // (not a live mark at all, so it gets no timestamp rather than a
  // misleading one).
  priced_at: string | null;
  // Purely informational take-profit/invalidation levels the competitor
  // recorded -- null if never set. Nothing enforces these (no auto-close,
  // no alert); revisable anytime via POST .../positions/{id}/price-targets/
  // without a new trade, since a competitor routinely moves a stop/target
  // on a position it already holds rather than only at entry.
  target_price: string | null;
  dead_price: string | null;
  opened_at: string;
}

// AI-only fields (assistant_model/system_prompt) are absent entirely on a
// human row, not null -- same convention as CompetitorSummary.
export interface CompetitorDetail {
  id: number;
  name: string;
  kind: CompetitorKind;
  cash_balance: string;
  account_value: string;
  total_return_pct: string;
  assistant_model?: string;
  system_prompt?: string;
  // Budget fields (AI competitors only) -- see ScoreboardCompetitor's comment.
  total_budget_usd?: string | null;
  weekly_budget_usd?: string | null;
  week_spent_usd?: string | null;
  today_spent_usd?: string | null;
  // Oldest priced_at among the positions shown -- i.e. the least-fresh
  // number actually contributing to this response, not the newest. Null if
  // every position is on the avg_cost fallback (or there are no positions).
  prices_as_of: string | null;
  positions: Position[];
}

/** Unrealized P/L for one open position, in dollars. avg_cost is per-share
 *  (stock) or per-contract (options, the premium) -- multiply by
 *  quantity * 100 for the total dollar cost/credit, same convention
 *  finance-backend/docs/league-api.md uses. A long position's avg_cost was paid out (a
 *  debit); a short leg's was received upfront (a credit) -- netting that in
 *  with the opposite sign against current_value (already sign-aware: a
 *  negative liability for a short leg) gives the right answer for both. */
export function positionPnl(p: Position): number {
  const multiplier = p.instrument_type === "stock" ? 1 : 100;
  const costBasis = (p.is_short ? -1 : 1) * Number(p.avg_cost) * p.quantity * multiplier;
  return Number(p.current_value) - costBasis;
}

/** CSS class for coloring a P/L-derived figure -- "" (no color) at exactly
 *  breakeven. */
export function pnlClass(pnl: number): string {
  if (pnl > 0) return "pnl-positive";
  if (pnl < 0) return "pnl-negative";
  return "";
}

/** Prefill for TradeModal's "close this position" flow (the Sell/Buy-to-close
 *  button on an open positions table). */
export interface TradePrefill {
  ticker: string;
  side: TradeSide;
  instrumentType: InstrumentType;
  quantity: number;
  strike?: string;
  expiration?: string;
}

/** side is "buy_to_close" for a short leg (e.g. the short side of a covered
 *  call/cash-covered put), "sell" for a normal long position -- closing is
 *  never "sell_to_open" or a fresh "buy". strike drops Position's padded
 *  decimal zeros ("150.0000" -> "150") since NewTrade's strike is a bare
 *  string, and expiration is trimmed to a date-only YYYY-MM-DD in case the
 *  backend ever sends a fuller ISO timestamp -- the date <input> needs
 *  exactly that shape to prefill. */
export function positionToTradePrefill(position: Position): TradePrefill {
  return {
    ticker: position.ticker,
    side: position.is_short ? "buy_to_close" : "sell",
    instrumentType: position.instrument_type,
    quantity: position.quantity,
    strike: position.strike ? String(Number(position.strike)) : undefined,
    expiration: position.expiration ? position.expiration.slice(0, 10) : undefined,
  };
}

// fill_price/rejection_reason are both null/"" while status is "pending" --
// they only populate once the order actually resolves at the next open.
// They stay null/"" on a "cancelled" trade too -- a cancel never resolves
// the order, it just pulls it before that can happen.
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
  rejection_code: RejectionCode;
  created_at: string;
}

/** A trade row from the competition-wide feed (GET .../trades/), which is
 *  every competitor's trades merged together -- same fields as `Trade` plus
 *  who made it, since the per-competitor endpoint doesn't need to say. */
export interface CompetitionTrade extends Trade {
  competitor_id: number;
  competitor_name: string;
  competitor_kind: CompetitorKind;
}

export interface NewTrade {
  ticker: string;
  side: TradeSide;
  instrument_type: InstrumentType;
  quantity: number;
  strike?: string;
  expiration?: string;
  limit_price?: string;
  // Only meaningful on an opening side (buy/sell_to_open) -- recorded on
  // the resulting position, revisable later without a new trade via
  // setPriceTargets() below.
  target_price?: string;
  dead_price?: string;
  thesis: string;
}

/** Every active model across both providers, for the competitor-creation
 *  dropdown -- distinct from assistant.ts's listAssistantModels(), which is
 *  the Anthropic-only main-chat picker. */
export interface LeagueModel {
  model_id: string;
  display_name: string;
  provider: ModelProvider;
  is_default: boolean;
}

export interface NewCompetitor {
  name: string;
  kind: CompetitorKind;
  model?: string;
  system_prompt?: string;
  // Both default to "" server-side when omitted.
  color?: string;
  avatar?: string;
}

export interface Wakeup {
  id: number;
  run_at: string;
  reason: string;
  status: WakeupStatus;
  created_at: string;
  completed_at: string | null;
}

/** One of the 3 fixed daily floor slots (news/open/close) -- computed live
 *  rather than backed by a DB row, since an AgentWakeup only exists once a
 *  forced check-in actually fires. Always exactly 3, sorted soonest-first,
 *  so slot order isn't fixed news->open->close. */
export interface ForcedCheckin {
  label: string;
  next_run_at: string;
}

/** The competitor's own pending schedule_wakeup calls (status="scheduled",
 *  run_at in the future), soonest-first -- empty if it hasn't scheduled
 *  anything. Human competitors get both lists empty rather than a 400. */
export interface NextWakeups {
  forced_checkins: ForcedCheckin[];
  self_scheduled: Wakeup[];
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

// Assistant-role entries carry raw items verbatim from whichever provider
// ran the turn (`item.model_dump(exclude_none=True)` server-side) -- there's
// no shared shape between them, and per-provider the items aren't uniformly
// nested under a `content` array either:
//  - Anthropic: one entry per turn, `content` is an array of
//    text/tool_use/server_tool_use/web_search_tool_result blocks.
//  - OpenAI: one entry PER RESPONSE ITEM, fields flattened directly onto
//    the entry (llm_openai.py does `{"role": "assistant", **item.model_dump()}`
//    per item). `message` items keep their own `content` array of
//    output_text/refusal parts; `function_call_output` items carry no
//    `role` at all; `reasoning` items routinely have empty summary/content
//    (effort="low" requests no summary) plus an opaque `encrypted_content`
//    blob -- that's expected, not a bug.
//  - Gemini: one entry per `Part`, also flattened, and Part has NO `type`
//    discriminator at all (SDK contract: "exactly one field should be
//    set") -- the frontend has to sniff by which key is present
//    (function_call / function_response [role "tool"] / tool_call /
//    tool_response [textless server-side built-in tool step] / text, with
//    `thought: true` marking a text part as reasoning rather than final
//    output). `grounding_metadata` entries are backend-synthesized (not
//    SDK-native) and are the one Gemini entry that does carry a `type`.
// Kept loose rather than a full union since new item types (e.g. a future
// `image_generation_call`) shouldn't need a frontend change to render
// "something happened here" -- unrecognized shapes fall back to a raw,
// collapsed JSON dump rather than being silently dropped.
export interface TranscriptBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  [key: string]: unknown;
}

export interface TranscriptEntry {
  role?: "user" | "assistant" | "tool";
  type?: string;
  text?: string;
  content?: TranscriptBlock[];
  [key: string]: unknown;
}

export interface TurnDetail extends TurnSummary {
  transcript: TranscriptEntry[];
}

export interface Scratchpad {
  content: string;
  updated_at: string | null;
}

// Per-ticker counterpart to the scratchpad's single cross-ticker blob --
// most-recently-updated first, [] for competitors with no saved research yet.
export interface TickerMemory {
  ticker: string;
  content: string;
  updated_at: string;
}

export async function listCompetitions(): Promise<Competition[]> {
  const res = await apiFetch("/league/competitions/");
  return parseJsonOrThrow<Competition[]>(res);
}

export async function listModels(): Promise<LeagueModel[]> {
  const res = await apiFetch("/league/models/");
  return parseJsonOrThrow<LeagueModel[]>(res);
}

export async function getScoreboard(competitionId: number): Promise<Scoreboard> {
  const res = await apiFetch(`/league/competitions/${competitionId}/scoreboard/`);
  return parseJsonOrThrow<Scoreboard>(res);
}

/** Force a live re-quote of every open position in the competition. Async --
 *  this only confirms the job was queued; the actual refreshed scoreboard
 *  arrives as a `league.scoreboard_refreshed` event on
 *  ws/league/{competitionId}/ (finance-backend/docs/league-api.md's "Live competition
 *  feed"), not in this response. */
export async function refreshCompetition(competitionId: number): Promise<{ status: string; competition_id: number }> {
  const res = await apiFetch(`/league/competitions/${competitionId}/refresh/`, { method: "POST" });
  return parseJsonOrThrow(res);
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

export interface PriceTargetsUpdate {
  /** "" clears the level back to null rather than leaving it unset. */
  target_price?: string;
  dead_price?: string;
}

/** Revise target_price/dead_price on a position you already hold, without
 *  submitting a trade -- e.g. "I'm moving my stop up." At least one of the
 *  two fields is required. Human-only (an AI competitor's equivalent is its
 *  own set_price_targets tool, not this endpoint). */
export async function setPriceTargets(
  competitorId: number,
  positionId: number,
  update: PriceTargetsUpdate,
): Promise<Position> {
  const res = await apiFetch(`/league/competitors/${competitorId}/positions/${positionId}/price-targets/`, {
    method: "POST",
    body: JSON.stringify(update),
  });
  return parseJsonOrThrow<Position>(res);
}

/** Force a live re-quote of just this competitor's held tickers/contracts --
 *  narrower than refreshCompetition() above. Async -- the refreshed row
 *  arrives as a `league.competitor_refreshed` event on
 *  ws/league/{competitionId}/, not in this response, and that event's
 *  payload omits `positions` (only account-level fields refresh live) --
 *  re-GET getCompetitor() after it lands if the positions table needs to
 *  reflect the new marks too. */
export async function refreshCompetitor(competitorId: number): Promise<{ status: string; competitor_id: number }> {
  const res = await apiFetch(`/league/competitors/${competitorId}/refresh/`, { method: "POST" });
  return parseJsonOrThrow(res);
}

export async function listTrades(competitorId: number): Promise<Trade[]> {
  const res = await apiFetch(`/league/competitors/${competitorId}/trades/`);
  return parseJsonOrThrow<Trade[]>(res);
}

export interface ListCompetitionTradesParams {
  /** YYYY-MM-DD or full ISO datetime -- bare dates anchor to the ET trading day. */
  since?: string;
  until?: string;
  competitorKind?: CompetitorKind;
}

export async function listCompetitionTrades(
  competitionId: number,
  params: ListCompetitionTradesParams = {},
): Promise<CompetitionTrade[]> {
  const qs = new URLSearchParams();
  if (params.since) qs.set("since", params.since);
  if (params.until) qs.set("until", params.until);
  if (params.competitorKind) qs.set("competitor_kind", params.competitorKind);
  const query = qs.toString();
  const res = await apiFetch(`/league/competitions/${competitionId}/trades/${query ? `?${query}` : ""}`);
  return parseJsonOrThrow<CompetitionTrade[]>(res);
}

/** A fill and a pending order (queued because restrict_after_hours_trading
 *  is on and the market's closed) both return 201 now -- check body.status
 *  rather than the HTTP status to tell them apart. A rules-engine rejection
 *  (400) returns the same trade-row shape (`status`/`rejection_reason` carry
 *  the outcome) -- only a genuine validation error (missing/unparseable
 *  field) lacks a `status` and should surface as a thrown error instead. */
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

/** Cancel a still-pending (queued-for-next-open) order. Same ownership rule
 *  as trade submission -- only your own competitor's orders. A clean cancel
 *  (200) and losing the race against the resolver (409 -- the order already
 *  filled/rejected by the time this landed) both return the same full Trade
 *  row shape, so callers can upsert whatever comes back by id without a
 *  follow-up fetch either way: a 409 body's `status` is the order's real
 *  outcome (filled/rejected), not a rejection of the cancel request itself. */
export async function cancelTrade(competitorId: number, tradeId: number): Promise<Trade> {
  const res = await apiFetch(`/league/competitors/${competitorId}/trades/${tradeId}/cancel/`, { method: "POST" });
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

export async function getNextWakeups(competitorId: number): Promise<NextWakeups> {
  const res = await apiFetch(`/league/competitors/${competitorId}/wakeups/next/`);
  return parseJsonOrThrow<NextWakeups>(res);
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

export async function getTickerMemories(competitorId: number): Promise<TickerMemory[]> {
  const res = await apiFetch(`/league/competitors/${competitorId}/ticker-memories/`);
  return parseJsonOrThrow<TickerMemory[]>(res);
}

export interface EquityCurvePoint {
  at: string;
  account_value: string;
}

/** One entry per competitor in the competition, always -- a competitor
 *  with no snapshots yet gets `points: []`, not an absent entry
 *  (finance-backend/docs/league-api.md). Snapshots only run during market hours, so
 *  there are gaps overnight/on weekends -- connect across them rather
 *  than treating them as missing data. No historical backfill: a
 *  competitor's series starts at whenever the snapshot job first ran
 *  for them, not at competition start, so series can differ in length
 *  and start time. */
export interface EquityCurveSeries {
  competitor_id: number;
  name: string;
  points: EquityCurvePoint[];
}

export interface EquityCurveParams {
  /** YYYY-MM-DD or full ISO datetime, same semantics as listCompetitionTrades's. */
  since?: string;
  until?: string;
}

export async function getEquityCurve(
  competitionId: number,
  params: EquityCurveParams = {},
): Promise<EquityCurveSeries[]> {
  const qs = new URLSearchParams();
  if (params.since) qs.set("since", params.since);
  if (params.until) qs.set("until", params.until);
  const query = qs.toString();
  const res = await apiFetch(`/league/competitions/${competitionId}/equity-curve/${query ? `?${query}` : ""}`);
  return parseJsonOrThrow<EquityCurveSeries[]>(res);
}
