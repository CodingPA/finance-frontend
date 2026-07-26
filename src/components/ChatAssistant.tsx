// Floating chat button + side panel, mounted globally in App.tsx. Every
// click on the floating button starts a fresh conversation; the small
// history button lets you switch back to a previous one. Sends stream back
// over the realtime socket, tagged with conversation_id so a stale/other
// conversation's tokens don't land in the wrong bubble.

import { useEffect, useRef, useState, type ComponentPropsWithoutRef } from "react";
import { useLocation } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAuth } from "../context/AuthContext";
import { ApiError } from "../lib/api";
import { realtime } from "../lib/ws";
import { listDashboard, type DashboardCompany } from "../lib/companies";
import {
  listAssistantModels,
  listConversations,
  createConversation,
  listConversationMessages,
  sendConversationMessage,
  type AssistantModel,
  type AssistantConversation,
} from "../lib/assistant";

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
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [conversations, setConversations] = useState<AssistantConversation[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  // Negative, decrementing -- server message ids are positive, so local
  // (not-yet-persisted) bubble ids can never collide with a loaded history row.
  const nextLocalId = useRef(-1);
  const streamingIdRef = useRef<number | null>(null);
  const activeConversationIdRef = useRef<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Every click of the floating button is a new chat: reset to a blank,
  // not-yet-created conversation and reload the ticker/model context.
  useEffect(() => {
    if (!open) return;
    setTicker(tickerFromPath(location.pathname) ?? ALL_TICKERS);
    setConversationId(null);
    activeConversationIdRef.current = null;
    setMessages([]);
    streamingIdRef.current = null;
    setHistoryOpen(false);
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
  // Every event carries conversation_id; ignore anything not for the chat
  // that's currently open (another tab's conversation, a stale one, etc).
  useEffect(() => {
    const offToken = realtime.on("assistant.token", (message) => {
      if (message.conversation_id !== activeConversationIdRef.current) return;
      const id = streamingIdRef.current;
      const chunk = message.text;
      if (id === null || typeof chunk !== "string") return;
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, text: m.text + chunk } : m)));
    });
    const offComplete = realtime.on("assistant.complete", (message) => {
      if (message.conversation_id !== activeConversationIdRef.current) return;
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
      if (message.conversation_id !== activeConversationIdRef.current) return;
      const id = streamingIdRef.current;
      const errorText = typeof message.message === "string" ? message.message : "Assistant failed.";
      if (id !== null) {
        setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, text: errorText, streaming: false, error: true } : m)));
      } else {
        setMessages((prev) => [...prev, { id: nextLocalId.current--, role: "assistant", text: errorText, error: true }]);
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

  // Sending disables the input while the reply streams in, which blurs it --
  // refocus the moment it re-enables so the next message can be typed
  // straight away, with no click back into the box.
  useEffect(() => {
    if (!loading) inputRef.current?.focus();
  }, [loading]);

  if (status !== "authenticated") return null;

  const toggleHistory = () => {
    setHistoryOpen((prev) => {
      const next = !prev;
      if (next) {
        setHistoryLoading(true);
        listConversations()
          .then(setConversations)
          .catch(() => {})
          .finally(() => setHistoryLoading(false));
      }
      return next;
    });
  };

  const startNewChat = () => {
    setConversationId(null);
    activeConversationIdRef.current = null;
    setMessages([]);
    streamingIdRef.current = null;
    setHistoryOpen(false);
  };

  const openConversation = async (id: number) => {
    setHistoryOpen(false);
    setConversationId(id);
    activeConversationIdRef.current = id;
    setMessages([]);
    streamingIdRef.current = null;
    try {
      const history = await listConversationMessages(id);
      setMessages(history.map((m) => ({ id: m.id, role: m.role, text: m.text })));
    } catch (err) {
      setMessages([
        {
          id: nextLocalId.current--,
          role: "assistant",
          text: err instanceof ApiError ? err.message : "Failed to load that conversation.",
          error: true,
        },
      ]);
    }
  };

  const handleSend = async () => {
    const q = input.trim();
    if (!q || loading) return;
    setInput("");
    setLoading(true);

    const assistantId = nextLocalId.current--;
    setMessages((prev) => [
      ...prev,
      { id: nextLocalId.current--, role: "user", text: q },
      { id: assistantId, role: "assistant", text: "", streaming: true },
    ]);
    streamingIdRef.current = assistantId;

    try {
      let convId = conversationId;
      if (convId === null) {
        const created = await createConversation(q.slice(0, 60));
        convId = created.id;
        setConversationId(convId);
      }
      activeConversationIdRef.current = convId;
      await sendConversationMessage(convId, q, modelId || undefined);
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
            <div className="chat-history">
              <button
                type="button"
                className="btn btn-secondary btn-icon-sm"
                onClick={toggleHistory}
                aria-label="Previous chats"
                aria-expanded={historyOpen}
              >
                ▾
              </button>
              {historyOpen && (
                <div className="chat-history-menu elev-md">
                  <button type="button" className="chat-history-item chat-history-new" onClick={startNewChat}>
                    + New chat
                  </button>
                  {historyLoading && <div className="chat-history-empty text-muted">Loading…</div>}
                  {!historyLoading && conversations.length === 0 && (
                    <div className="chat-history-empty text-muted">No previous chats</div>
                  )}
                  {!historyLoading &&
                    conversations.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className={`chat-history-item${c.id === conversationId ? " chat-history-item-active" : ""}`}
                        onClick={() => openConversation(c.id)}
                      >
                        {c.title || "Untitled chat"}
                      </button>
                    ))}
                </div>
              )}
            </div>
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
              ref={inputRef}
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
