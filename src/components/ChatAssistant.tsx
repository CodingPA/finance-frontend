// Floating chat button + side panel, mounted globally in App.tsx. Every
// click on the floating button starts a fresh conversation; the small
// history button lets you switch back to a previous one. Replies stream
// back over the realtime socket, tagged with conversation_id so a stale/
// other conversation's tokens don't land in the wrong bubble.
//
// The assistant can also propose an action (e.g. ingesting a filing) that
// needs an explicit confirm/deny -- those render as their own list items
// (`PendingActionItem`), distinct from message bubbles, since a pending
// action's id comes from a different table and isn't safe to key alongside
// message ids.

import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { Markdown } from "./Markdown";
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
  respondToPendingAction,
  type AssistantModel,
  type AssistantConversation,
} from "../lib/assistant";

interface ChatMessageItem {
  kind: "message";
  id: number;
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
  error?: boolean;
  /** Set on user rows when that turn was ticker-scoped. */
  ticker?: string | null;
  /** Usage/cost -- only ever populated on assistant rows. */
  modelId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  toolCalls?: string[];
  toolUseOutputTokens?: number | null;
  costUsd?: string | null;
}

type PendingActionStatus = "pending" | "working" | "error";

interface PendingActionItem {
  kind: "pending";
  pendingActionId: number;
  description: string;
  status: PendingActionStatus;
  errorText?: string;
}

type ChatItem = ChatMessageItem | PendingActionItem;

const ALL_TICKERS = "__all__";

function tickerFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/screen\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function ChatAssistant() {
  const { status } = useAuth();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [companies, setCompanies] = useState<DashboardCompany[]>([]);
  // Scopes each sent message to one company via the per-message `ticker`
  // field; "All tickers" just means the turn goes unscoped for now.
  const [ticker, setTicker] = useState<string>(ALL_TICKERS);
  const [models, setModels] = useState<AssistantModel[]>([]);
  const [modelId, setModelId] = useState<string>("");
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [conversations, setConversations] = useState<AssistantConversation[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  // Negative, decrementing -- server message ids are positive, so local
  // (not-yet-persisted) bubble ids can never collide with a loaded history row.
  const nextLocalId = useRef(-1);
  const streamingIdRef = useRef<number | null>(null);
  const activeConversationIdRef = useRef<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Only auto-scroll while the user is already at (or near) the bottom --
  // otherwise every streamed token yanks them back down mid-read.
  const stickToBottomRef = useRef(true);

  // Every click of the floating button is a new chat: reset to a blank,
  // not-yet-created conversation and reload the ticker/model context.
  useEffect(() => {
    if (!open) return;
    setTicker(tickerFromPath(location.pathname) ?? ALL_TICKERS);
    setConversationId(null);
    activeConversationIdRef.current = null;
    setItems([]);
    streamingIdRef.current = null;
    stickToBottomRef.current = true;
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
      setItems((prev) =>
        prev.map((item) => (item.kind === "message" && item.id === id ? { ...item, text: item.text + chunk } : item)),
      );
    });
    const offComplete = realtime.on("assistant.complete", (message) => {
      if (message.conversation_id !== activeConversationIdRef.current) return;
      const id = streamingIdRef.current;
      if (id === null) return;
      const finalText = message.text;
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.filter((t) => typeof t === "string") : undefined;
      setItems((prev) =>
        prev.map((item) =>
          item.kind === "message" && item.id === id
            ? {
                ...item,
                text: typeof finalText === "string" ? finalText : item.text,
                streaming: false,
                modelId: typeof message.model_id === "string" ? message.model_id : item.modelId,
                inputTokens: typeof message.input_tokens === "number" ? message.input_tokens : item.inputTokens,
                outputTokens: typeof message.output_tokens === "number" ? message.output_tokens : item.outputTokens,
                toolCalls: toolCalls ?? item.toolCalls,
                toolUseOutputTokens:
                  typeof message.tool_use_output_tokens === "number" ? message.tool_use_output_tokens : item.toolUseOutputTokens,
                costUsd: typeof message.cost_usd === "string" ? message.cost_usd : item.costUsd,
              }
            : item,
        ),
      );
      streamingIdRef.current = null;
      setLoading(false);
    });
    const offError = realtime.on("assistant.error", (message) => {
      if (message.conversation_id !== activeConversationIdRef.current) return;
      const id = streamingIdRef.current;
      const errorText = typeof message.message === "string" ? message.message : "Assistant failed.";
      if (id !== null) {
        setItems((prev) =>
          prev.map((item) =>
            item.kind === "message" && item.id === id ? { ...item, text: errorText, streaming: false, error: true } : item,
          ),
        );
      } else {
        setItems((prev) => [
          ...prev,
          { kind: "message", id: nextLocalId.current--, role: "assistant", text: errorText, error: true },
        ]);
      }
      streamingIdRef.current = null;
      setLoading(false);
    });
    // The assistant proposes an action (e.g. ingesting a filing) and waits
    // for a confirm/deny -- this can arrive alongside a normal
    // assistant.complete for the same turn, so it's appended independently
    // rather than attached to the streaming bubble above.
    const offConfirmation = realtime.on("assistant.confirmation_required", (message) => {
      if (message.conversation_id !== activeConversationIdRef.current) return;
      const pendingActionId = message.pending_action_id;
      if (typeof pendingActionId !== "number") return;
      const description =
        typeof message.description === "string"
          ? message.description
          : `Confirm ${message.form ?? "filing"} for ${message.ticker ?? "this company"}?`;
      setItems((prev) => [...prev, { kind: "pending", pendingActionId, description, status: "pending" }]);
    });
    // Fires once the background job (ingest or decline) actually finishes.
    // Not streamed -- one complete event, which is also a real message row,
    // so swap the pending card for a normal assistant bubble.
    const offActionComplete = realtime.on("assistant.action_complete", (message) => {
      if (message.conversation_id !== activeConversationIdRef.current) return;
      const pendingActionId = message.pending_action_id;
      const text = typeof message.text === "string" ? message.text : "Done.";
      const messageId = typeof message.message_id === "number" ? message.message_id : nextLocalId.current--;
      setItems((prev) =>
        prev.map((item) =>
          item.kind === "pending" && item.pendingActionId === pendingActionId
            ? { kind: "message", id: messageId, role: "assistant", text }
            : item,
        ),
      );
    });
    return () => {
      offToken();
      offComplete();
      offError();
      offConfirmation();
      offActionComplete();
    };
  }, []);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [items, loading]);

  const handleBodyScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // Sending disables the input while the reply streams in, which blurs it --
  // refocus the moment it re-enables so the next message can be typed
  // straight away, with no click back into the box.
  useEffect(() => {
    if (!loading) inputRef.current?.focus();
  }, [loading]);

  if (status !== "authenticated") return null;

  const modelDisplayName = (id: string) => models.find((m) => m.model_id === id)?.display_name ?? id;

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
    setItems([]);
    streamingIdRef.current = null;
    stickToBottomRef.current = true;
    setHistoryOpen(false);
  };

  const openConversation = async (id: number) => {
    setHistoryOpen(false);
    setConversationId(id);
    activeConversationIdRef.current = id;
    setItems([]);
    streamingIdRef.current = null;
    stickToBottomRef.current = true;
    try {
      const history = await listConversationMessages(id);
      setItems(
        history.map((m) => ({
          kind: "message",
          id: m.id,
          role: m.role,
          text: m.text,
          ticker: m.ticker,
          modelId: m.model_id,
          inputTokens: m.input_tokens,
          outputTokens: m.output_tokens,
          toolCalls: m.tool_calls,
          toolUseOutputTokens: m.tool_use_output_tokens,
          costUsd: m.cost_usd,
        })),
      );
    } catch (err) {
      setItems([
        {
          kind: "message",
          id: nextLocalId.current--,
          role: "assistant",
          text: err instanceof ApiError ? err.message : "Failed to load that conversation.",
          error: true,
        },
      ]);
    }
  };

  const respondPending = async (pendingActionId: number, approved: boolean) => {
    setItems((prev) =>
      prev.map((item) => (item.kind === "pending" && item.pendingActionId === pendingActionId ? { ...item, status: "working" } : item)),
    );
    const convId = activeConversationIdRef.current;
    if (convId === null) return;
    try {
      await respondToPendingAction(convId, pendingActionId, approved);
    } catch (err) {
      const errorText = err instanceof ApiError ? err.message : "Failed to record your response.";
      setItems((prev) =>
        prev.map((item) =>
          item.kind === "pending" && item.pendingActionId === pendingActionId
            ? { ...item, status: "error", errorText }
            : item,
        ),
      );
    }
  };

  const handleSend = async () => {
    const q = input.trim();
    if (!q || loading) return;
    setInput("");
    setLoading(true);
    stickToBottomRef.current = true;

    const scopeTicker = ticker === ALL_TICKERS ? undefined : ticker;
    const assistantId = nextLocalId.current--;
    setItems((prev) => [
      ...prev,
      { kind: "message", id: nextLocalId.current--, role: "user", text: q, ticker: scopeTicker ?? null },
      { kind: "message", id: assistantId, role: "assistant", text: "", streaming: true },
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
      await sendConversationMessage(convId, q, { modelId: modelId || undefined, ticker: scopeTicker });
    } catch (err) {
      const errorText = err instanceof ApiError ? err.message : "Failed to send message.";
      setItems((prev) =>
        prev.map((item) =>
          item.kind === "message" && item.id === assistantId ? { ...item, text: errorText, streaming: false, error: true } : item,
        ),
      );
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
          <div className="chat-drawer-body" ref={bodyRef} onScroll={handleBodyScroll}>
            {items.length === 0 && (
              <p className="text-muted chat-empty">
                Ask something about {ticker === ALL_TICKERS ? "your tracked companies" : ticker}.
              </p>
            )}
            {items.map((item) =>
              item.kind === "pending" ? (
                <div key={`pending-${item.pendingActionId}`} className="chat-msg chat-msg-assistant">
                  <div className="chat-pending card elev-sm">
                    <p className="chat-pending-desc">{item.description}</p>
                    {item.status === "pending" && (
                      <div className="chat-pending-actions">
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={() => respondPending(item.pendingActionId, true)}
                        >
                          Ingest
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => respondPending(item.pendingActionId, false)}
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                    {item.status === "working" && <p className="text-muted chat-pending-status">Working on it…</p>}
                    {item.status === "error" && <p className="chat-pending-status chat-msg-error">{item.errorText}</p>}
                  </div>
                </div>
              ) : (
                <div key={`msg-${item.id}`} className={`chat-msg chat-msg-${item.role}`}>
                  {item.role === "user" && item.ticker && (
                    <div className="chat-msg-ticker">
                      <span className="tag tag-accent">{item.ticker}</span>
                    </div>
                  )}
                  <div className={`chat-msg-text${item.role === "assistant" ? " markdown-body" : ""}${item.error ? " chat-msg-error" : ""}`}>
                    {item.role === "assistant" ? <Markdown>{item.text || (item.streaming ? "…" : "")}</Markdown> : item.text}
                  </div>
                  {item.role === "assistant" && !item.streaming && !item.error && item.modelId && (
                    <div className="chat-msg-usage info-tip text-muted" tabIndex={0}>
                      {modelDisplayName(item.modelId)} · {(item.inputTokens ?? 0) + (item.outputTokens ?? 0)} tokens · $
                      {Number(item.costUsd ?? 0).toFixed(4)}
                      <div className="info-tip-bubble chat-usage-bubble">
                        <div>Input: {item.inputTokens ?? 0} tokens</div>
                        <div>
                          Output: {item.outputTokens ?? 0} tokens
                          {item.toolUseOutputTokens != null && (
                            <>
                              {" "}
                              ({Math.max((item.outputTokens ?? 0) - item.toolUseOutputTokens, 0)} answer + {item.toolUseOutputTokens}{" "}
                              tool use)
                            </>
                          )}
                        </div>
                        {item.toolCalls && item.toolCalls.length > 0 && <div>Tools: {item.toolCalls.join(", ")}</div>}
                      </div>
                    </div>
                  )}
                </div>
              ),
            )}
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
