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
import { useChat } from "../context/ChatContext";
import { useIsMobile } from "../hooks/useIsMobile";
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
  type AssistantModelProvider,
  type AssistantConversation,
} from "../lib/assistant";

const PROVIDER_LABELS: Record<AssistantModelProvider, string> = {
  anthropic: "Claude",
  openai: "OpenAI",
  gemini: "Gemini",
};

// Fixed display order regardless of what order the API lists models in --
// only shows up as <optgroup> headers, so a provider with no models
// returned just doesn't get a group.
const PROVIDER_ORDER: AssistantModelProvider[] = ["anthropic", "openai", "gemini"];

function groupModelsByProvider(models: AssistantModel[]): [AssistantModelProvider, AssistantModel[]][] {
  const groups = new Map<AssistantModelProvider, AssistantModel[]>();
  for (const m of models) {
    if (!groups.has(m.provider)) groups.set(m.provider, []);
    groups.get(m.provider)!.push(m);
  }
  return PROVIDER_ORDER.filter((p) => groups.has(p)).map((p) => [p, groups.get(p)!]);
}

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

// Desktop-only panel width, dragged from the left edge -- mobile keeps the
// CSS default (min(380px, 100vw), i.e. full-width) since there's no room to
// resize a drawer that's already filling the screen. Remembered across
// visits the same way ThemeContext remembers light/dark.
const CHAT_WIDTH_STORAGE_KEY = "chatDrawerWidth";
const CHAT_WIDTH_DEFAULT = 380;
const CHAT_WIDTH_MIN = 320;
const CHAT_WIDTH_MAX = 720;

function getInitialChatWidth(): number {
  const stored = Number(localStorage.getItem(CHAT_WIDTH_STORAGE_KEY));
  if (Number.isFinite(stored) && stored > 0) return Math.min(Math.max(stored, CHAT_WIDTH_MIN), CHAT_WIDTH_MAX);
  return CHAT_WIDTH_DEFAULT;
}

function tickerFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/screen\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

// Message text size -- applied to .chat-drawer-body as an inline font-size
// (see app.css's .chat-msg-text/.chat-empty/.chat-pending-desc, which
// inherit it rather than hardcoding their own). Same localStorage-remembers
// pattern as CHAT_WIDTH above.
const CHAT_FONT_SIZE_STORAGE_KEY = "chatFontSize";
const CHAT_FONT_SIZE_DEFAULT = 13;
const CHAT_FONT_SIZE_MIN = 12;
const CHAT_FONT_SIZE_MAX = 20;
const CHAT_FONT_SIZE_STEP = 1;

function getInitialChatFontSize(): number {
  const stored = Number(localStorage.getItem(CHAT_FONT_SIZE_STORAGE_KEY));
  if (Number.isFinite(stored) && stored > 0) return Math.min(Math.max(stored, CHAT_FONT_SIZE_MIN), CHAT_FONT_SIZE_MAX);
  return CHAT_FONT_SIZE_DEFAULT;
}

// The composer starts at one line and grows with the content, up to this
// many lines -- past that it scrolls internally rather than swallowing the
// message history above it.
const CHAT_INPUT_MAX_ROWS = 6;

export function ChatAssistant() {
  const { status } = useAuth();
  const location = useLocation();
  const isMobile = useIsMobile();
  // Mobile opens the drawer from BottomNav's own tab instead of a floating
  // button, so the open/closed flag is shared via context rather than kept
  // as local state here.
  const { open, setOpen } = useChat();
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
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [chatFontSize, setChatFontSize] = useState<number>(getInitialChatFontSize);
  // Only auto-scroll while the user is already at (or near) the bottom --
  // otherwise every streamed token yanks them back down mid-read.
  const stickToBottomRef = useRef(true);

  const [chatWidth, setChatWidth] = useState<number>(getInitialChatWidth);
  // The drag effect below is mounted once and reads these through refs
  // rather than closing over `chatWidth` state, same reasoning as every
  // other stale-closure ref in this codebase -- mousemove fires far faster
  // than React re-renders would keep up with.
  const chatWidthRef = useRef(chatWidth);
  useEffect(() => {
    chatWidthRef.current = chatWidth;
  }, [chatWidth]);
  const resizingRef = useRef(false);
  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(0);

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    dragStartXRef.current = e.clientX;
    dragStartWidthRef.current = chatWidthRef.current;
    document.body.style.userSelect = "none";
  };

  // Mounted for the component's lifetime (not just while dragging) so a
  // mouseup that lands outside the handle -- or even outside the window --
  // still ends the drag instead of leaving it stuck following the cursor.
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!resizingRef.current) return;
      // The panel is right-anchored, so moving the cursor left (a smaller
      // clientX) is what should grow it.
      const delta = dragStartXRef.current - e.clientX;
      const maxWidth = Math.min(CHAT_WIDTH_MAX, window.innerWidth - 80);
      const next = Math.min(Math.max(dragStartWidthRef.current + delta, CHAT_WIDTH_MIN), maxWidth);
      setChatWidth(next);
    };
    const handleMouseUp = () => {
      if (!resizingRef.current) return;
      resizingRef.current = false;
      document.body.style.userSelect = "";
      localStorage.setItem(CHAT_WIDTH_STORAGE_KEY, String(chatWidthRef.current));
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(CHAT_FONT_SIZE_STORAGE_KEY, String(chatFontSize));
  }, [chatFontSize]);

  const decreaseChatFontSize = () => setChatFontSize((prev) => Math.max(CHAT_FONT_SIZE_MIN, prev - CHAT_FONT_SIZE_STEP));
  const increaseChatFontSize = () => setChatFontSize((prev) => Math.min(CHAT_FONT_SIZE_MAX, prev + CHAT_FONT_SIZE_STEP));

  // Grows the composer with its content up to CHAT_INPUT_MAX_ROWS, then lets
  // it scroll internally -- the standard "reset height, measure scrollHeight,
  // clamp" auto-resize technique. Reading the DOM directly (rather than
  // computing rows from `input`'s newline count) is what keeps this correct
  // for soft-wrapped lines too, not just explicit \n's.
  const resizeInput = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const computed = getComputedStyle(el);
    const lineHeight = parseFloat(computed.lineHeight) || 20;
    // box-sizing: border-box (global reset) means scrollHeight already
    // includes padding/border -- the row cap needs to too, or it clips
    // noticeably before CHAT_INPUT_MAX_ROWS actual lines of text fit.
    const verticalPadding = parseFloat(computed.paddingTop) + parseFloat(computed.paddingBottom);
    const borderHeight = parseFloat(computed.borderTopWidth) + parseFloat(computed.borderBottomWidth);
    const maxHeight = lineHeight * CHAT_INPUT_MAX_ROWS + verticalPadding + borderHeight;
    const next = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  };

  // Also re-measure on chatWidth changes -- narrowing the panel can force
  // existing text to soft-wrap onto an extra line before the user types
  // anything new, and the height should reflect that immediately rather
  // than waiting for the next keystroke.
  useEffect(() => {
    resizeInput();
  }, [input, chatWidth]);

  // Every click of the floating button is a new chat: reset to a blank,
  // not-yet-created conversation and reload the ticker/model context.
  useEffect(() => {
    if (!open) return;
    setTicker(tickerFromPath(location.pathname) ?? ALL_TICKERS);
    setConversationId(null);
    activeConversationIdRef.current = null;
    setItems([]);
    streamingIdRef.current = null;
    // A reply still streaming for the previous conversation will have its
    // complete/error event filtered out below (wrong conversation_id), so
    // nothing else would ever re-enable the composer.
    setLoading(false);
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
  const modelProvider = (id: string) => models.find((m) => m.model_id === id)?.provider;

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
    setLoading(false);
    stickToBottomRef.current = true;
    setHistoryOpen(false);
  };

  const openConversation = async (id: number) => {
    setHistoryOpen(false);
    setConversationId(id);
    activeConversationIdRef.current = id;
    setItems([]);
    streamingIdRef.current = null;
    setLoading(false);
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

  // Enter sends (matching the old single-line <input>'s native behavior);
  // Shift+Enter inserts a newline, the standard chat-composer convention
  // now that this is a <textarea>.
  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <>
      {!open && !isMobile && (
        <button type="button" className="chat-fab btn btn-primary elev-md" onClick={() => setOpen(true)} aria-label="Open chat assistant">
          Chat
        </button>
      )}
      {open && (
        <div className="chat-drawer elev-lg" style={!isMobile ? { width: chatWidth } : undefined}>
          {!isMobile && (
            <div
              className="chat-drawer-resize-handle"
              onMouseDown={handleResizeStart}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize chat panel"
            />
          )}
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
              {groupModelsByProvider(models).map(([provider, group]) => (
                <optgroup key={provider} label={PROVIDER_LABELS[provider]}>
                  {group.map((m) => (
                    <option key={m.model_id} value={m.model_id}>
                      {m.display_name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <div className="chat-font-controls">
              <button
                type="button"
                className="btn btn-secondary btn-icon-sm"
                onClick={decreaseChatFontSize}
                disabled={chatFontSize <= CHAT_FONT_SIZE_MIN}
                aria-label="Decrease chat text size"
                title="Smaller text"
              >
                A−
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-icon-sm"
                onClick={increaseChatFontSize}
                disabled={chatFontSize >= CHAT_FONT_SIZE_MAX}
                aria-label="Increase chat text size"
                title="Larger text"
              >
                A+
              </button>
            </div>
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
          <div className="chat-drawer-body" ref={bodyRef} onScroll={handleBodyScroll} style={{ fontSize: chatFontSize }}>
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
                      {modelProvider(item.modelId) && (
                        <span
                          className={`tag ${modelProvider(item.modelId) === "openai" ? "tag-accent-2" : "tag-accent"}`}
                          style={{ padding: "1px 6px", marginRight: 4 }}
                        >
                          {PROVIDER_LABELS[modelProvider(item.modelId)!]}
                        </span>
                      )}
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
            <textarea
              ref={inputRef}
              className="input chat-input-textarea"
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleInputKeyDown}
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
