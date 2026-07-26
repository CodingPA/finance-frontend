// Floating chat button + side panel, mounted globally in App.tsx. Sends
// messages to the chat assistant (first slice: stateless, no tools) and
// renders the streamed reply as it arrives over the realtime socket.

import { useEffect, useRef, useState, type ComponentPropsWithoutRef } from "react";
import { useLocation } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAuth } from "../context/AuthContext";
import { ApiError } from "../lib/api";
import { realtime } from "../lib/ws";
import { listDashboard, type DashboardCompany } from "../lib/companies";
import { listAssistantModels, sendAssistantMessage, type AssistantModel } from "../lib/assistant";

interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
  error?: boolean;
}

const ALL_TICKERS = "__all__";

function tickerFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/screen\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

// Assistant replies render as markdown (tables, lists, etc. via remark-gfm);
// wide tables get their own scroll container instead of blowing out the
// narrow drawer, and links open in a new tab instead of navigating the app.
const markdownComponents = {
  table: (props: ComponentPropsWithoutRef<"table">) => (
    <div className="chat-table-wrap">
      <table {...props} />
    </div>
  ),
  a: (props: ComponentPropsWithoutRef<"a">) => <a {...props} target="_blank" rel="noopener noreferrer" />,
};

export function ChatAssistant() {
  const { status } = useAuth();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [companies, setCompanies] = useState<DashboardCompany[]>([]);
  // Scopes future tool-backed replies to one company; the assistant's first
  // slice has no tools, so this isn't sent to the backend yet.
  const [ticker, setTicker] = useState<string>(ALL_TICKERS);
  const [models, setModels] = useState<AssistantModel[]>([]);
  const [modelId, setModelId] = useState<string>("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const nextId = useRef(0);
  const streamingIdRef = useRef<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Default the ticker to whatever screen the user is on, and load the
  // tracked-company + model lists, each time the panel is opened.
  useEffect(() => {
    if (!open) return;
    setTicker(tickerFromPath(location.pathname) ?? ALL_TICKERS);
    listDashboard()
      .then(setCompanies)
      .catch(() => {});
    listAssistantModels()
      .then((list) => {
        setModels(list);
        setModelId((current) => current || list.find((m) => m.is_default)?.model_id || list[0]?.model_id || "");
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Assistant replies stream in over the same user socket ScreenerPage uses
  // for screen.* events -- one subscription for the component's lifetime.
  useEffect(() => {
    const offToken = realtime.on("assistant.token", (message) => {
      const id = streamingIdRef.current;
      const chunk = message.text;
      if (id === null || typeof chunk !== "string") return;
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, text: m.text + chunk } : m)));
    });
    const offComplete = realtime.on("assistant.complete", (message) => {
      const id = streamingIdRef.current;
      if (id === null) return;
      const finalText = message.text;
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, text: typeof finalText === "string" ? finalText : m.text, streaming: false } : m)),
      );
      streamingIdRef.current = null;
      setLoading(false);
    });
    const offError = realtime.on("assistant.error", (message) => {
      const id = streamingIdRef.current;
      const errorText = typeof message.message === "string" ? message.message : "Assistant failed.";
      if (id !== null) {
        setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, text: errorText, streaming: false, error: true } : m)));
      } else {
        setMessages((prev) => [...prev, { id: nextId.current++, role: "assistant", text: errorText, error: true }]);
      }
      streamingIdRef.current = null;
      setLoading(false);
    });
    return () => {
      offToken();
      offComplete();
      offError();
    };
  }, []);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [messages, loading]);

  if (status !== "authenticated") return null;

  const handleSend = async () => {
    const q = input.trim();
    if (!q || loading) return;
    setInput("");
    setLoading(true);

    const assistantId = nextId.current++;
    setMessages((prev) => [
      ...prev,
      { id: nextId.current++, role: "user", text: q },
      { id: assistantId, role: "assistant", text: "", streaming: true },
    ]);
    streamingIdRef.current = assistantId;

    try {
      await sendAssistantMessage(q, modelId || undefined);
    } catch (err) {
      const errorText = err instanceof ApiError ? err.message : "Failed to send message.";
      setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, text: errorText, streaming: false, error: true } : m)));
      streamingIdRef.current = null;
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
            <select className="input" value={modelId} onChange={(e) => setModelId(e.target.value)} aria-label="Model">
              {models.map((m) => (
                <option key={m.model_id} value={m.model_id}>
                  {m.display_name}
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
            {messages.map((m) => (
              <div key={m.id} className={`chat-msg chat-msg-${m.role}`}>
                <div className={`chat-msg-text${m.error ? " chat-msg-error" : ""}`}>
                  {m.role === "assistant" ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                      {m.text || (m.streaming ? "…" : "")}
                    </ReactMarkdown>
                  ) : (
                    m.text
                  )}
                </div>
              </div>
            ))}
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
              placeholder="Ask the assistant…"
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
