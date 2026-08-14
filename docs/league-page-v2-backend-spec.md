# League page v2 — backend spec

Redesigning `/league` to match the new mockup (screenshots/league-1.png,
league-2.png). Most of the page is derivable from data we already have; this
spec covers only what's new.

## 1. Per-competitor scalar fields (scoreboard + competitor list)

Add to the rows returned by `GET /league/competitions/{id}/scoreboard/`
(and/or `GET /league/competitions/{id}/competitors/`, wherever makes more
sense given the existing shape):

- `filled_trades_count: number` — count of this competitor's trades with
  `status="filled"`.
- `api_cost_usd: string | null` — sum of `cost_usd` across the competitor's
  turns. `null`/`"0"` for a competitor that's never woken (human row shows
  "—" in the mockup).
- `last_woke_at: string | null` (ISO datetime) — timestamp of the
  competitor's most recent completed turn. `null` renders as "never".

Rationale: the standings table needs Trades / API cost / Last woke per row.
Today the frontend would have to hit `listTrades()` + `listTurns()` per
competitor (N+1) to get these — pushing the aggregation into the scoreboard
response avoids that.

## 2. Rejected-trade reason breakdown (competition-level)

The footer shows "3 rejected on price limits" alongside the filled-trade
total. Filled trades and API cost are both derivable client-side by summing
the per-competitor fields in #1, but the rejection count/reason isn't.

Add something like:

```
GET /league/competitions/{id}/scoreboard/
{
  ...
  "rejected_trades": [
    { "reason": "price_limit", "count": 3 },
    ...
  ]
}
```

Exact reason taxonomy TBD — whatever buckets `rejection_reason` already
groups into on the backend is fine; the frontend just needs counts per
bucket for the competition as a whole.

## 3. Equity curve endpoint (new)

The biggest gap. Nothing today returns account-value history — needed for
both the big equity chart and the per-row sparklines in standings.

```
GET /league/competitions/{id}/equity-curve/?since=&until=&interval=
```

Response: one series per competitor, timestamp + account value per point.

```json
[
  {
    "competitor_id": 1,
    "name": "Gemini Gambling Daytrader",
    "points": [
      { "at": "2026-08-12T13:30:00Z", "account_value": "5000.00" },
      { "at": "2026-08-12T14:30:00Z", "account_value": "6120.00" },
      ...
    ]
  },
  ...
]
```

Needs:
- **Intraday granularity**, not daily closes. The mockup's Aug 12→13 curve
  has clear intraday shape (multiple vertices within a single day) — two
  points a day can't render that. Hourly, or a snapshot on every price
  refresh, whichever is cheaper given existing infra (may already be close
  to what `refresh`/`TickerSnapshot` does for prices — if so, snapshotting
  `account_value` alongside is probably the natural hook).
- **Downsampling left to the frontend.** The same payload should serve both
  the full-resolution hero chart and the tiny standings sparklines — no
  need for a second, coarser endpoint. A `interval=` param (e.g. `1h`,
  `1d`) is a nice-to-have for the 84-day full-competition view, not
  required for v1.
- One series per competitor in a single call, not one call per competitor.

Open questions for backend to answer (not resolved in this spec):
- **Backfill**: can Aug 12–13 (or however far back the competition already
  ran before this ships) be reconstructed from trade history + existing
  ticker snapshots, or does every competitor's curve start empty from
  whenever the snapshot job goes live?
- **Mid-league joiners**: how should a competitor added partway through the
  competition appear — a short series starting at their join date, or
  padded flat back to competition start? Affects whether the frontend needs
  to special-case short series or can treat all series as equal-length.

Not backend's concern: the mockup's "Four flat accounts" legend entry is a
frontend-side collapse of near-flat series for chart legibility, not a
grouping the API needs to produce.

## 4. Strategy tagline (open product question, not resolved here)

The hero card and standings show a short descriptor under each AI
competitor's name (e.g. "1DTE options, 20-25% per bullet") distinct from
the full `system_prompt` paragraph shown elsewhere on the page.

Before speccing this as backend work, need a product decision: is this a
new short field set at competitor creation (small `CharField`, plus a field
added to `AddCompetitorModal`), or just the first line of `system_prompt`
truncated on the frontend? If the former, add e.g. `strategy_label:
string | null` to `CompetitorSummary`/`CompetitorDetail`.

## Not in scope (already derivable client-side, no backend change)

- Day counter ("DAY 2 OF 84") — from `competition.start_date`/`end_date`.
- Rank — client-side sort by `total_return_pct`. **Needs a documented
  tiebreak** (e.g. id ascending) since multiple competitors can tie at
  0.0%/$5,000 and would otherwise reorder on every scoreboard refresh —
  this is a frontend implementation detail but flagging it here since it
  affects perceived data stability.
- "Lead over 2nd" — computable from the sorted scoreboard. **Needs product
  clarification before frontend implements it**: the mockup's "+85.0 pts"
  doesn't match leader-minus-2nd (82.8 − 0.1 = 82.7); it matches
  leader-minus-last (82.8 − (−2.2) = 85.0). Possibly the label should read
  differently (e.g. "spread" rather than "lead over 2nd"). Flagging for
  whoever owns the design, not a backend question.
- Footer tiles (league total value vs. deployed, trades filled, spend,
  $/point of return) — all arithmetic over the per-competitor fields in #1
  plus `competition.starting_capital` × competitor count.
- Next forced check-in banner — already available per-competitor via
  `GET /league/competitors/{id}/wakeups/next/` (`forced_checkins`), which
  is identical across all competitors (3 fixed daily slots), so a single
  call covers the competition-wide banner.
