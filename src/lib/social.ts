// Client for the Reddit "Social" discovery endpoints: a user watches
// subreddits, a backend job scans them twice daily and records which
// tickers are genuinely being discussed (LLM-attributed, not keyword
// matching -- so there's no ticker-collision risk the way a naive scan
// would have). Auth-required, scoped to the logged-in user's own watches.

import { apiFetch, parseJsonOrThrow } from "./api";

export interface TrackedSubreddit {
  id: number;
  name: string;
  added_at: string;
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
 *  one place that gets turned into a real, clickable URL. */
export function redditUrl(permalink: string): string {
  return `https://reddit.com${permalink}`;
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

/** Aggregated ticker-mention counts across every subreddit this user
 *  watches, highest-first. */
export async function listMentionCounts(): Promise<SubredditMentionCount[]> {
  const res = await apiFetch("/companies/subreddit-mentions/");
  return parseJsonOrThrow<SubredditMentionCount[]>(res);
}

/** The actual posts behind one ticker's mention count. */
export async function listMentionPosts(ticker: string): Promise<SubredditMentionPost[]> {
  const res = await apiFetch(`/companies/subreddit-mentions/?ticker=${encodeURIComponent(ticker)}`);
  return parseJsonOrThrow<SubredditMentionPost[]>(res);
}
