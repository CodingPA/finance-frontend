// Reddit "Social" discovery feed: watch subreddits, see which tickers a
// twice-daily backend scan found people actually discussing there (LLM-
// attributed, not keyword matching), and drill into the actual posts behind
// a ticker. The backend's own schedule is still the primary source, but a
// watch can also be force-rescanned on demand -- "Refresh" (one subreddit)
// and "Refresh all" both just queue the same scan job early and report
// progress over the realtime socket (subreddit.progress/complete/error,
// unwrapped events on /ws/user/, fire-and-forget same as screen.* -- a
// missed push just means the next re-fetch below is stale until the
// fallback timeout clears it).

import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { realtime } from "../lib/ws";
import { extractGenericMessage } from "../lib/formErrors";
import { formatDateTime, formatLastWoke } from "../lib/format";
import {
  addTrackedSubreddit,
  listMentionCounts,
  listMentionPosts,
  listTrackedSubreddits,
  redditUrl,
  refreshAllSubreddits,
  refreshSubreddit,
  removeTrackedSubreddit,
  type SubredditMentionCount,
  type SubredditMentionPost,
  type TrackedSubreddit,
} from "../lib/social";

// A rescan is a backend job reading recent posts through an LLM, not a
// quote refresh -- give it real room before assuming the push was lost.
const SCAN_FALLBACK_MS = 2 * 60_000;
// How long a completed/failed scan's result stays visible under its row
// before fading back to the plain "Last scanned" line.
const FLASH_MS = 8_000;

// The backend aggregates by (subreddit, ticker) pair -- this table wants
// the ticker as the row instead, with every subreddit that mentioned it
// folded into one badge list, so this groups the API's rows client-side
// rather than adding a second aggregation endpoint for what's a display
// concern.
interface TickerAggregate {
  ticker: string;
  count: number;
  subreddits: { subreddit: string; count: number }[];
}

function aggregateByTicker(counts: SubredditMentionCount[]): TickerAggregate[] {
  const byTicker = new Map<string, TickerAggregate>();
  for (const row of counts) {
    let agg = byTicker.get(row.ticker);
    if (!agg) {
      agg = { ticker: row.ticker, count: 0, subreddits: [] };
      byTicker.set(row.ticker, agg);
    }
    agg.count += row.count;
    agg.subreddits.push({ subreddit: row.subreddit, count: row.count });
  }
  const list = [...byTicker.values()];
  for (const agg of list) agg.subreddits.sort((a, b) => b.count - a.count);
  list.sort((a, b) => b.count - a.count);
  return list;
}

export function SocialPage() {
  const [watches, setWatches] = useState<TrackedSubreddit[] | null>(null);
  const [counts, setCounts] = useState<SubredditMentionCount[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [countsLoading, setCountsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Separate from `error` above -- that one's for the watch list itself
  // (load/add/remove), this is scoped to the filtered trending-tickers
  // fetch so a stale filter error doesn't linger once an unrelated action
  // (e.g. a rescan) succeeds, and a fresh filter error doesn't get buried
  // under whatever `error` last held.
  const [countsError, setCountsError] = useState<string | null>(null);

  const [newSubreddit, setNewSubreddit] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [subredditFilter, setSubredditFilter] = useState("");
  const [daysFilter, setDaysFilter] = useState("");
  // WS handlers close over these through refs rather than the effect's own
  // deps, same reasoning as LeaguePage's kindFilterRef -- a subscription
  // that tore down and reconnected on every filter keystroke could drop an
  // event arriving in that gap.
  const subredditFilterRef = useRef(subredditFilter);
  const daysFilterRef = useRef(daysFilter);
  useEffect(() => {
    subredditFilterRef.current = subredditFilter;
  }, [subredditFilter]);
  useEffect(() => {
    daysFilterRef.current = daysFilter;
  }, [daysFilter]);

  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const [posts, setPosts] = useState<SubredditMentionPost[] | null>(null);
  const [postsError, setPostsError] = useState<string | null>(null);

  // Per-subreddit-id rescan lifecycle: scanning (queued or running -- the
  // UI doesn't distinguish the two, subreddit.progress just confirms what
  // the POST already optimistically showed) and the transient result
  // banner once a subreddit.complete/error lands.
  const [scanning, setScanning] = useState<Set<number>>(new Set());
  const [scanFlash, setScanFlash] = useState<Map<number, { ok: boolean; message: string }>>(new Map());
  const [refreshAllPending, setRefreshAllPending] = useState(false);
  const scanTimeoutsRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const flashTimeoutsRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const currentFilterParams = () => ({
    subreddit: subredditFilterRef.current || undefined,
    days: daysFilterRef.current ? Number(daysFilterRef.current) : undefined,
  });

  const refreshWatches = () => {
    listTrackedSubreddits()
      .then((w) => setWatches(w))
      .catch(() => {});
  };

  const refreshCounts = () => {
    listMentionCounts(currentFilterParams())
      .then((c) => setCounts(c))
      .catch(() => {});
  };

  const clearScanTimeout = (id: number) => {
    const timer = scanTimeoutsRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      scanTimeoutsRef.current.delete(id);
    }
  };

  const startScanning = (id: number) => {
    setScanning((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    clearScanTimeout(id);
    scanTimeoutsRef.current.set(
      id,
      setTimeout(() => {
        scanTimeoutsRef.current.delete(id);
        setScanning((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        // No terminal event ever arrived -- re-fetch cold rather than trust
        // the stale watch/count rows any further.
        refreshWatches();
        refreshCounts();
      }, SCAN_FALLBACK_MS),
    );
  };

  const stopScanning = (id: number) => {
    setScanning((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    clearScanTimeout(id);
  };

  const showFlash = (id: number, ok: boolean, message: string) => {
    setScanFlash((prev) => new Map(prev).set(id, { ok, message }));
    const existing = flashTimeoutsRef.current.get(id);
    if (existing) clearTimeout(existing);
    flashTimeoutsRef.current.set(
      id,
      setTimeout(() => {
        flashTimeoutsRef.current.delete(id);
        setScanFlash((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
      }, FLASH_MS),
    );
  };

  useEffect(() => {
    let cancelled = false;
    listTrackedSubreddits()
      .then((w) => !cancelled && setWatches(w))
      .catch((err) => {
        if (!cancelled) setError(extractGenericMessage(err, "Couldn't load the social feed."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Also covers the initial load of counts (subredditFilter/daysFilter both
  // start "" -- all-time, every watched subreddit), so there's no separate
  // combined-fetch-on-mount case to keep in sync with this one.
  useEffect(() => {
    let cancelled = false;
    setCountsLoading(true);
    setCountsError(null);
    listMentionCounts({ subreddit: subredditFilter || undefined, days: daysFilter ? Number(daysFilter) : undefined })
      .then((c) => !cancelled && setCounts(c))
      .catch((err) => {
        if (!cancelled) setCountsError(extractGenericMessage(err, "Couldn't load trending tickers."));
      })
      .finally(() => {
        if (!cancelled) setCountsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [subredditFilter, daysFilter]);

  // Posts across every subreddit that mentioned this ticker -- scoped by
  // the page's own subreddit/days filters (if set), not by a single row,
  // since a row is now the whole ticker rather than one subreddit+ticker
  // pair.
  useEffect(() => {
    if (!selectedTicker) return;
    let cancelled = false;
    setPosts(null);
    setPostsError(null);
    listMentionPosts(selectedTicker, {
      subreddit: subredditFilter || undefined,
      days: daysFilter ? Number(daysFilter) : undefined,
    })
      .then((rows) => !cancelled && setPosts(rows))
      .catch((err) => {
        if (!cancelled) setPostsError(extractGenericMessage(err, "Couldn't load those posts."));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedTicker, subredditFilter, daysFilter]);

  // subreddit.progress -- just confirms a queued scan actually started; the
  // POST response already put the button in "Scanning…", this is a no-op
  // for a subreddit already tracked and a safety net for one that isn't
  // (e.g. a scan someone else queued, or this tab reconnecting mid-scan).
  useEffect(() => {
    return realtime.on("subreddit.progress", (message) => {
      const id = message.subreddit_id;
      if (typeof id !== "number") return;
      startScanning(id);
    });
  }, []);

  useEffect(() => {
    return realtime.on("subreddit.complete", (message) => {
      const id = message.subreddit_id;
      if (typeof id !== "number") return;
      const tickers = Array.isArray(message.tickers) ? message.tickers.filter((t): t is string => typeof t === "string") : [];
      const newMentions = typeof message.new_mentions === "number" ? message.new_mentions : null;
      stopScanning(id);
      showFlash(
        id,
        true,
        newMentions && newMentions > 0
          ? `+${newMentions} new mention${newMentions === 1 ? "" : "s"}${tickers.length ? `: ${tickers.join(", ")}` : ""}`
          : "Scanned -- no new mentions",
      );
      refreshWatches();
      refreshCounts();
    });
  }, []);

  useEffect(() => {
    return realtime.on("subreddit.error", (message) => {
      const id = message.subreddit_id;
      if (typeof id !== "number") return;
      const msg = typeof message.message === "string" ? message.message : "Scan failed.";
      stopScanning(id);
      showFlash(id, false, msg);
      // last_scanned_at is set on every attempt, success or failure.
      refreshWatches();
    });
  }, []);

  // Clear every outstanding timer on unmount.
  useEffect(() => {
    return () => {
      scanTimeoutsRef.current.forEach((t) => clearTimeout(t));
      scanTimeoutsRef.current.clear();
      flashTimeoutsRef.current.forEach((t) => clearTimeout(t));
      flashTimeoutsRef.current.clear();
    };
  }, []);

  const handleAdd = async (e: FormEvent) => {
    e.preventDefault();
    if (!newSubreddit.trim()) return;
    setAdding(true);
    setAddError(null);
    try {
      const watch = await addTrackedSubreddit(newSubreddit.trim());
      setWatches((prev) => [...(prev ?? []), watch]);
      setNewSubreddit("");
      // Otherwise a freshly-added watch just sits at last_scanned_at: null
      // until the next twice-daily run -- kick off its first scan right
      // away instead of making the user notice it's empty and hit Refresh
      // themselves. handleRefreshOne already swallows its own errors (shows
      // a flash instead), so the watch stays added either way.
      handleRefreshOne(watch.id);
    } catch (err) {
      setAddError(extractGenericMessage(err, "Couldn't add that subreddit."));
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (id: number) => {
    setWatches((prev) => (prev ?? []).filter((w) => w.id !== id));
    stopScanning(id);
    setScanFlash((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    try {
      await removeTrackedSubreddit(id);
    } catch (err) {
      setError(extractGenericMessage(err, "Couldn't remove that subreddit."));
    }
  };

  const handleRefreshOne = async (id: number) => {
    startScanning(id);
    try {
      await refreshSubreddit(id);
    } catch (err) {
      stopScanning(id);
      showFlash(id, false, extractGenericMessage(err, "Couldn't trigger a rescan."));
    }
  };

  const handleRefreshAll = async () => {
    if (!watches || watches.length === 0) return;
    setRefreshAllPending(true);
    setError(null);
    try {
      const result = await refreshAllSubreddits();
      // Only mark every watch as scanning when `count` says all of them
      // actually got queued -- the response gives no ids, so if it queued
      // fewer (a row already mid-scan, a rate limit, whatever `count` is
      // counting) there's no way to tell which ones. Marking all of them
      // anyway would leave the ones that were never queued stuck showing
      // "Scanning…" for the full fallback window, wedging this same button
      // (it's gated on anyScanning) the whole time. Left unmarked, each
      // subreddit still picks up "Scanning…" for real the moment its own
      // subreddit.progress lands.
      if (result.count === watches.length) {
        watches.forEach((w) => startScanning(w.id));
      }
    } catch (err) {
      setError(extractGenericMessage(err, "Couldn't trigger a rescan."));
    } finally {
      setRefreshAllPending(false);
    }
  };

  const anyScanning = scanning.size > 0;
  const tickerAggregates = useMemo(() => (counts ? aggregateByTicker(counts) : []), [counts]);

  return (
    <div className="page">
      <div className="page-head">
        <h2>Social</h2>
      </div>
      <p className="text-muted">
        Watch a subreddit and a twice-daily scan reads what's actually being posted there -- tickers are identified by an
        LLM reading real content, not keyword matching, so there's no "SLS the rocket vs. $SLS the stock" noise. Use
        Refresh to jump the queue instead of waiting for the next scheduled scan.
      </p>

      {loading && <p className="text-muted">Loading…</p>}
      {error && <p className="form-error">{error}</p>}

      {!loading && (
        <>
          <div className="card elev-sm stack">
            <div className="card-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span>Watched subreddits</span>
              {watches && watches.length > 0 && (
                <button
                  type="button"
                  className="btn btn-secondary btn-icon-sm"
                  style={{ marginLeft: "auto", width: "auto", padding: "0 10px" }}
                  onClick={handleRefreshAll}
                  disabled={refreshAllPending || anyScanning}
                  title="Rescan every watched subreddit right now"
                >
                  {refreshAllPending || anyScanning ? "Scanning…" : "Refresh all"}
                </button>
              )}
            </div>
            <form className="page-head" style={{ marginBottom: 0 }} onSubmit={handleAdd}>
              <input
                className="input"
                style={{ maxWidth: 240 }}
                value={newSubreddit}
                onChange={(e) => setNewSubreddit(e.target.value)}
                placeholder="wallstreetbets"
                aria-label="Subreddit name"
              />
              <button type="submit" className="btn btn-primary" disabled={adding}>
                {adding ? "Adding…" : "Watch"}
              </button>
            </form>
            {addError && <p className="form-error">{addError}</p>}

            {watches && watches.length === 0 && (
              <p className="text-muted">Watch a subreddit to start scanning it twice daily.</p>
            )}
            {watches && watches.length > 0 && (
              <div className="stack" style={{ gap: 8 }}>
                {watches.map((w) => {
                  const isScanning = scanning.has(w.id);
                  const flash = scanFlash.get(w.id);
                  return (
                    <div key={w.id} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span className="tag tag-neutral">r/{w.name}</span>
                        <span className="text-muted card-meta">
                          {isScanning ? "Scanning…" : `Last scanned ${formatLastWoke(w.last_scanned_at)}`}
                        </span>
                        <button
                          type="button"
                          className="btn btn-secondary btn-icon-sm"
                          style={{ width: "auto", padding: "0 10px", gap: 4 }}
                          onClick={() => handleRefreshOne(w.id)}
                          disabled={isScanning}
                          aria-label={`Rescan r/${w.name}`}
                          title="Rescan now"
                        >
                          {isScanning ? "Scanning…" : "⟳ Refresh"}
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon-sm"
                          onClick={() => handleRemove(w.id)}
                          aria-label={`Stop watching r/${w.name}`}
                          title="Stop watching"
                        >
                          ×
                        </button>
                      </div>
                      {flash && <p className={flash.ok ? "pnl-positive" : "form-error"} style={{ margin: 0 }}>{flash.message}</p>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="card elev-sm stack">
            <div className="card-title">Trending tickers</div>

            {watches && watches.length > 0 && (
              <div className="screener-search">
                <div className="field">
                  <label htmlFor="social-subreddit-filter">Subreddit</label>
                  <select
                    id="social-subreddit-filter"
                    className="input"
                    value={subredditFilter}
                    onChange={(e) => setSubredditFilter(e.target.value)}
                  >
                    <option value="">All watched</option>
                    {watches.map((w) => (
                      <option key={w.id} value={w.name}>
                        r/{w.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="social-days-filter">Window</label>
                  <select id="social-days-filter" className="input" value={daysFilter} onChange={(e) => setDaysFilter(e.target.value)}>
                    <option value="">All time</option>
                    <option value="1">Last 24h</option>
                    <option value="7">Last 7 days</option>
                    <option value="30">Last 30 days</option>
                  </select>
                </div>
              </div>
            )}

            {countsError && <p className="form-error">{countsError}</p>}
            {watches && watches.length === 0 && (
              <p className="text-muted">No subreddits watched yet -- nothing to scan.</p>
            )}
            {watches && watches.length > 0 && countsLoading && <p className="text-muted">Loading…</p>}
            {watches && watches.length > 0 && !countsLoading && tickerAggregates.length === 0 && (
              <p className="text-muted">
                {subredditFilter || daysFilter
                  ? "No mentions match these filters."
                  : "Watching, but no mentions found yet -- the next scan hasn't run."}
              </p>
            )}
            {!countsLoading && tickerAggregates.length > 0 && (
              <div className="table-wrap stack-mobile">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Ticker</th>
                      <th>Mentions</th>
                      <th>Subreddits</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tickerAggregates.map((agg) => {
                      const isSelected = selectedTicker === agg.ticker;
                      return (
                        <Fragment key={agg.ticker}>
                          <tr
                            onClick={() => setSelectedTicker((prev) => (prev === agg.ticker ? null : agg.ticker))}
                            className={isSelected ? "league-row-active" : undefined}
                            style={{ cursor: "pointer" }}
                          >
                            <td data-label="Ticker">
                              <strong>{agg.ticker}</strong>
                            </td>
                            <td data-label="Mentions">{agg.count}</td>
                            <td data-label="Subreddits">
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                                {agg.subreddits.map((s) => (
                                  <span
                                    key={s.subreddit}
                                    className="tag tag-neutral"
                                    title={`${s.count} mention${s.count === 1 ? "" : "s"} in r/${s.subreddit}`}
                                  >
                                    r/{s.subreddit}
                                  </span>
                                ))}
                              </div>
                            </td>
                          </tr>
                          {isSelected && (
                            <tr>
                              <td colSpan={3} className="league-expanded-cell">
                                {postsError && <p className="form-error">{postsError}</p>}
                                {!postsError && !posts && <p className="text-muted">Loading posts…</p>}
                                {posts && posts.length === 0 && <p className="text-muted">No posts found.</p>}
                                {posts && posts.length > 0 && (
                                  <div className="stack">
                                    {posts.map((p) => (
                                      <div className="card elev-sm" key={p.id}>
                                        <a href={redditUrl(p.permalink)} target="_blank" rel="noreferrer">
                                          <strong>{p.title}</strong>
                                        </a>
                                        {p.excerpt && <p className="card-body clamp-text">{p.excerpt}</p>}
                                        <div className="card-meta">
                                          r/{p.subreddit} · {p.score ?? "—"} score · {p.num_comments ?? "—"} comments
                                          · {formatDateTime(p.scanned_at)}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
