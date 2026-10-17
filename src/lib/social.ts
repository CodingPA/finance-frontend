// Client for the Reddit "Social" discovery endpoints: a user watches
// subreddits, a backend job scans them twice daily and records which
// tickers are genuinely being discussed (LLM-attributed, not keyword
// matching -- so there's no ticker-collision risk the way a naive scan
// would have). Auth-required, scoped to the logged-in user's own watches.
// A watch can also be force-rescanned on demand (refreshSubreddit /
// refreshAllSubreddits) -- both just queue the same scan job early and
// report progress over the realtime socket (see SocialPage's "subreddit."
// event handlers), same async-POST-then-WS-push shape as the league page's
// refresh buttons.

import { apiFetch, parseJsonOrThrow } from "./api";

export interface TrackedSubreddit {
  id: number;
  name: string;
  added_at: string;
  // Set on every scan attempt, success or failure -- null until the first
  // scan ever runs for this watch. A value that stops advancing is the
  // signal the scan job isn't reaching this row, not proof of a quiet sub.
  last_scanned_at: string | null;
}

export interface QueuedRefresh {
  status: string;
  id: number;
  name: string;
}

export interface QueuedRefreshAll {
  status: string;
  count: number;
}

/** One row of the aggregated board -- how many scanned posts in `subreddit`
 *  mentioned `ticker`, across every scan so far. Sorted highest-first by
 *  the API already. */
export interface SubredditMentionCount {
  subreddit: string;
  ticker: string;
  count: number;
}

/** One post behind a `SubredditMentionCount` row -- the "click a ticker to
 *  see context" drill-down. `permalink` is a relative Reddit path (Reddit's
 *  own raw field, stored verbatim) -- use redditUrl() to build a real link,
 *  never render it bare. */
export interface SubredditMentionPost {
  id: number;
  subreddit: string;
  ticker: string;
  title: string;
  permalink: string;
  excerpt: string;
  score: number | null;
  num_comments: number | null;
  scanned_at: string;
}

/** `permalink` (from a SubredditMentionPost, or a source_type: "reddit"
 *  ResearchClip's `source`) is always a relative Reddit path -- this is the
 *  one place that gets turned into a real, clickable URL. A clip's `source`
 *  is user-entered, so the leading "/" is enforced rather than trusted --
 *  without it, "@evil.com" would build https://reddit.com@evil.com, a link
 *  to evil.com. */
export function redditUrl(permalink: string): string {
  return `https://reddit.com${permalink.startsWith("/") ? "" : "/"}${permalink}`;
}

export async function listTrackedSubreddits(): Promise<TrackedSubreddit[]> {
  const res = await apiFetch("/companies/subreddits/");
  return parseJsonOrThrow<TrackedSubreddit[]>(res);
}

/** Accepts either "wallstreetbets" or "r/wallstreetbets" -- the server
 *  strips a leading r/ either way. */
export async function addTrackedSubreddit(name: string): Promise<TrackedSubreddit> {
  const res = await apiFetch("/companies/subreddits/", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  return parseJsonOrThrow<TrackedSubreddit>(res);
}

export async function removeTrackedSubreddit(id: number): Promise<void> {
  const res = await apiFetch(`/companies/subreddits/${id}/`, { method: "DELETE" });
  await parseJsonOrThrow<void>(res);
}

/** Queues an immediate rescan of one watch rather than waiting for the next
 *  twice-daily run. Async -- 202 just confirms it's queued; the actual
 *  result arrives as subreddit.progress -> subreddit.complete/error on the
 *  realtime socket, matched by this response's `id`. */
export async function refreshSubreddit(id: number): Promise<QueuedRefresh> {
  const res = await apiFetch(`/companies/subreddits/${id}/refresh/`, { method: "POST" });
  return parseJsonOrThrow<QueuedRefresh>(res);
}

/** Same as refreshSubreddit but for every watch at once -- the socket still
 *  fires one full progress/complete/error triple per subreddit queued, not
 *  one combined event, so `count` here is just "how many to expect." */
export async function refreshAllSubreddits(): Promise<QueuedRefreshAll> {
  const res = await apiFetch("/companies/subreddits/refresh/", { method: "POST" });
  return parseJsonOrThrow<QueuedRefreshAll>(res);
}

export interface MentionFilterParams {
  subreddit?: string;
  /** Positive integer lookback window in days; omitted means all-time. */
  days?: number;
}

/** Aggregated ticker-mention counts across every subreddit this user
 *  watches, highest-first -- optionally narrowed to one subreddit and/or a
 *  lookback window. */
export async function listMentionCounts(params: MentionFilterParams = {}): Promise<SubredditMentionCount[]> {
  const qs = new URLSearchParams();
  if (params.subreddit) qs.set("subreddit", params.subreddit);
  if (params.days) qs.set("days", String(params.days));
  const query = qs.toString();
  const res = await apiFetch(`/companies/subreddit-mentions/${query ? `?${query}` : ""}`);
  return parseJsonOrThrow<SubredditMentionCount[]>(res);
}

/** The actual posts behind one ticker's mention count -- pass the same
 *  `subreddit`/`days` a caller used for listMentionCounts to keep a
 *  drill-down scoped to the row that was actually clicked, rather than
 *  pulling in every other subreddit's posts for the same ticker too. */
export async function listMentionPosts(ticker: string, params: MentionFilterParams = {}): Promise<SubredditMentionPost[]> {
  const qs = new URLSearchParams({ ticker });
  if (params.subreddit) qs.set("subreddit", params.subreddit);
  if (params.days) qs.set("days", String(params.days));
  const res = await apiFetch(`/companies/subreddit-mentions/?${qs.toString()}`);
  return parseJsonOrThrow<SubredditMentionPost[]>(res);
}
