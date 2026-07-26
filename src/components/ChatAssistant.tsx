// Floating chat button + side panel, mounted globally in App.tsx. For now
// this just hits the Phase 6 clip-search endpoint and prints the raw
// results (console + in-panel) -- wiring it into an actual AI assistant
// is a later phase.

import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { ApiError } from "../lib/api";
import { listDashboard, type DashboardCompany } from "../lib/companies";
import { searchClips, type ClipSearchResult } from "../lib/chat";

interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  /** Plain text -- user queries, errors, "no results" notices. */
  text?: string;
  /** Search results -- rendered as collapsible cards instead of `text`. */
  results?: ClipSearchResult[];
}

const ALL_TICKERS = "__all__";

function tickerFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/screen\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function ClipResultCard({ result }: { result: ClipSearchResult }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="clip-card card elev-sm">
      <button
        type="button"
        className="clip-card-head"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="tag tag-accent clip-card-ticker">{result.ticker}</span>
        <span className="clip-card-label">{result.label}</span>
        <span className="text-muted clip-card-distance">{result.distance.toFixed(3)}</span>
        <span className="clip-card-caret" aria-hidden="true">
          {expanded ? "−" : "+"}
        </span>
      </button>
      {expanded && (
        <div className="clip-card-body">
          <p className="text-muted clip-card-source">{result.source}</p>
          <p className="clip-card-text">{result.text}</p>
        </div>
      )}
    </div>
  );
}

export function ChatAssistant() {
  const { status } = useAuth();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [companies, setCompanies] = useState<DashboardCompany[]>([]);
  const [ticker, setTicker] = useState<string>(ALL_TICKERS);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const nextId = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Default the ticker to whatever screen the user is on each time the
  // panel is opened, without overriding a manual pick while it stays open.
  useEffect(() => {
    if (!open) return;
    setTicker(tickerFromPath(location.pathname) ?? ALL_TICKERS);
    listDashboard()
      .then(setCompanies)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [messages, loading]);

  if (status !== "authenticated") return null;

  const addText = (role: ChatMessage["role"], text: string) => {
    setMessages((prev) => [...prev, { id: nextId.current++, role, text }]);
  };

  const addResults = (results: ClipSearchResult[]) => {
    setMessages((prev) => [...prev, { id: nextId.current++, role: "assistant", results }]);
  };

  const handleSend = async () => {
    const q = input.trim();
    if (!q || loading) return;
    setInput("");
    addText("user", q);
    setLoading(true);
    try {
      const scopeTicker = ticker === ALL_TICKERS ? undefined : ticker;
      const results = await searchClips(q, scopeTicker);
      console.log("clips/search results", results);
      if (results.length === 0) {
        addText("assistant", "No matching clips found.");
      } else {
        addResults(results);
      }
    } catch (err) {
      addText("assistant", err instanceof ApiError ? err.message : "Search failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {!open && (
        <button
          type="button"
          className="chat-fab btn btn-primary elev-md"
          onClick={() => setOpen(true)}
          aria-label="Open chat assistant"
        >
          Chat
        </button>
      )}
      {open && (
        <div className="chat-drawer elev-lg">
          <div className="chat-drawer-head">
            <select className="input" value={ticker} onChange={(e) => setTicker(e.target.value)} aria-label="Scope">
              <option value={ALL_TICKERS}>All tickers</option>
              {companies.map((c) => (
                <option key={c.ticker} value={c.ticker}>
                  {c.ticker}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-secondary btn-icon"
              onClick={() => setOpen(false)}
              aria-label="Close chat"
            >
              &times;
            </button>
          </div>
          <div className="chat-drawer-body" ref={bodyRef}>
            {messages.length === 0 && (
              <p className="text-muted chat-empty">
                Ask something about {ticker === ALL_TICKERS ? "your tracked companies" : ticker}.
              </p>
            )}
            {messages.map((m) =>
              m.results ? (
                <div key={m.id} className="chat-msg chat-msg-assistant chat-results">
                  <p className="text-muted chat-results-count">
                    {m.results.length} result{m.results.length === 1 ? "" : "s"}
                  </p>
                  {m.results.map((r) => (
                    <ClipResultCard key={r.id} result={r} />
                  ))}
                </div>
              ) : (
                <div key={m.id} className={`chat-msg chat-msg-${m.role}`}>
                  <div className="chat-msg-text">{m.text}</div>
                </div>
              ),
            )}
            {loading && <p className="text-muted">Searching…</p>}
          </div>
          <form
            className="chat-drawer-input"
            onSubmit={(e) => {
              e.preventDefault();
              handleSend();
            }}
          >
            <input
              className="input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about a company…"
              disabled={loading}
            />
            <button type="submit" className="btn btn-primary" disabled={loading || !input.trim()}>
              Send
            </button>
          </form>
        </div>
      )}
    </>
  );
}
