// Reddit "Social" discovery feed: watch subreddits, see which tickers a
// twice-daily backend scan found people actually discussing there (LLM-
// attributed, not keyword matching), and drill into the actual posts
// behind a ticker. Nothing here triggers a live fetch -- everything is
// populated on the backend's own schedule, so a freshly-watched subreddit
// can legitimately show zero mentions until the next scan runs.

import { Fragment, useEffect, useState, type FormEvent } from "react";
import { extractGenericMessage } from "../lib/formErrors";
import { formatDateTime } from "../lib/format";
import {
  addTrackedSubreddit,
  listMentionCounts,
  listMentionPosts,
  listTrackedSubreddits,
  redditUrl,
  removeTrackedSubreddit,
  type SubredditMentionCount,
  type SubredditMentionPost,
  type TrackedSubreddit,
} from "../lib/social";

export function SocialPage() {
  const [watches, setWatches] = useState<TrackedSubreddit[] | null>(null);
  const [counts, setCounts] = useState<SubredditMentionCount[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newSubreddit, setNewSubreddit] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const [posts, setPosts] = useState<SubredditMentionPost[] | null>(null);
  const [postsError, setPostsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listTrackedSubreddits(), listMentionCounts()])
      .then(([w, c]) => {
        if (cancelled) return;
        setWatches(w);
        setCounts(c);
      })
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

  useEffect(() => {
    if (!selectedTicker) return;
    let cancelled = false;
    setPosts(null);
    setPostsError(null);
    listMentionPosts(selectedTicker)
      .then((rows) => !cancelled && setPosts(rows))
      .catch((err) => {
        if (!cancelled) setPostsError(extractGenericMessage(err, "Couldn't load those posts."));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedTicker]);

  const handleAdd = async (e: FormEvent) => {
    e.preventDefault();
    if (!newSubreddit.trim()) return;
    setAdding(true);
    setAddError(null);
    try {
      const watch = await addTrackedSubreddit(newSubreddit.trim());
      setWatches((prev) => [...(prev ?? []), watch]);
      setNewSubreddit("");
    } catch (err) {
      setAddError(extractGenericMessage(err, "Couldn't add that subreddit."));
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (id: number) => {
    setWatches((prev) => (prev ?? []).filter((w) => w.id !== id));
    try {
      await removeTrackedSubreddit(id);
    } catch (err) {
      setError(extractGenericMessage(err, "Couldn't remove that subreddit."));
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h2>Social</h2>
      </div>
      <p className="text-muted">
        Watch a subreddit and a twice-daily scan reads what's actually being posted there -- tickers are identified by an
        LLM reading real content, not keyword matching, so there's no "SLS the rocket vs. $SLS the stock" noise.
      </p>

      {loading && <p className="text-muted">Loading…</p>}
      {error && <p className="form-error">{error}</p>}

      {!loading && (
        <>
          <div className="card elev-sm stack">
            <div className="card-title">Watched subreddits</div>
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
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {watches.map((w) => (
                  <span key={w.id} className="tag tag-neutral" style={{ gap: 6 }}>
                    r/{w.name}
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon-sm"
                      style={{ padding: 0 }}
                      onClick={() => handleRemove(w.id)}
                      aria-label={`Stop watching r/${w.name}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="card elev-sm stack">
            <div className="card-title">Trending tickers</div>
            {watches && watches.length === 0 && (
              <p className="text-muted">No subreddits watched yet -- nothing to scan.</p>
            )}
            {watches && watches.length > 0 && counts && counts.length === 0 && (
              <p className="text-muted">Watching, but no mentions found yet -- the next scan hasn't run.</p>
            )}
            {counts && counts.length > 0 && (
              <div className="table-wrap stack-mobile">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Subreddit</th>
                      <th>Ticker</th>
                      <th>Mentions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {counts.map((row) => {
                      const rowKey = `${row.subreddit}:${row.ticker}`;
                      const isSelected = selectedTicker === row.ticker;
                      return (
                        <Fragment key={rowKey}>
                          <tr
                            onClick={() => setSelectedTicker((prev) => (prev === row.ticker ? null : row.ticker))}
                            className={isSelected ? "league-row-active" : undefined}
                            style={{ cursor: "pointer" }}
                          >
                            <td data-label="Subreddit">r/{row.subreddit}</td>
                            <td data-label="Ticker">
                              <strong>{row.ticker}</strong>
                            </td>
                            <td data-label="Mentions">{row.count}</td>
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
