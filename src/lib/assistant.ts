// Client for the chat assistant. Conversations persist server-side; each
// only carries its own last 10 messages as context (no injected data yet).
// A sent message's reply never comes back on the POST -- it streams over
// the user's realtime socket as assistant.token / assistant.complete /
// assistant.error, tagged with conversation_id (see lib/ws.ts).

import { apiFetch, parseJsonOrThrow, ApiError } from "./api";

export type AssistantModelProvider = "anthropic" | "openai" | "gemini";

// Streaming, tool calls, cost tracking, and error handling are all
// provider-agnostic server-side -- `provider` exists purely so the picker
// can group/badge models, not because the frontend needs to branch on it
// anywhere else.
export interface AssistantModel {
  model_id: string;
  display_name: string;
  provider: AssistantModelProvider;
  is_default: boolean;
}

export interface AssistantConversation {
  id: number;
  title: string | null;
}

export type AssistantMessageRole = "user" | "assistant";

export interface AssistantMessage {
  id: number;
  role: AssistantMessageRole;
  text: string;
  /** Only ever set on user rows -- what that turn was scoped to, if anything. */
  ticker: string | null;
  model_id: string | null;
  /** Summed across every tool-calling round-trip in the turn. */
  input_tokens: number | null;
  output_tokens: number | null;
  /** Tools that actually ran, in order -- [] if none. */
  tool_calls: string[];
  /** Slice of output_tokens spent deciding to call tools (+ preamble); the
   *  rest of output_tokens is the final answer text. No input-side split
   *  exists -- each round resends the whole conversation, so a round's
   *  input total isn't meaningfully attributable to that round's tool call. */
  tool_use_output_tokens: number | null;
  /** A Decimal server-side, so it arrives as a string -- Number()/parseFloat before summing. */
  cost_usd: string | null;
}

/** Admin-managed model catalog -- the same list `model_id` validates against. */
export async function listAssistantModels(): Promise<AssistantModel[]> {
  const res = await apiFetch("/assistant/models/");
  return parseJsonOrThrow<AssistantModel[]>(res);
}

/** Newest-active first. */
export async function listConversations(): Promise<AssistantConversation[]> {
  const res = await apiFetch("/assistant/conversations/");
  return parseJsonOrThrow<AssistantConversation[]>(res);
}

export async function createConversation(title?: string): Promise<AssistantConversation> {
  const res = await apiFetch("/assistant/conversations/", {
    method: "POST",
    body: JSON.stringify(title ? { title } : {}),
  });
  return parseJsonOrThrow<AssistantConversation>(res);
}

export async function deleteConversation(id: number): Promise<void> {
  const res = await apiFetch(`/assistant/conversations/${id}/`, { method: "DELETE" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body);
  }
}

/** A failed turn still shows up as an assistant row (its text explains what
 *  went wrong), so this is always renderable top to bottom with no gaps. */
export async function listConversationMessages(id: number): Promise<AssistantMessage[]> {
  const res = await apiFetch(`/assistant/conversations/${id}/messages/`);
  return parseJsonOrThrow<AssistantMessage[]>(res);
}

export interface SendMessageOptions {
  modelId?: string;
  /** Case-insensitive, resolved server-side. Omit for an unscoped turn --
   *  one conversation can freely mix scoped and unscoped messages. */
  ticker?: string;
}

/** Queues the assistant run and returns the user message row you just sent
 *  (202) -- safe to append immediately. The reply streams over the socket.
 *  400s with {"ticker": ["Ticker 'ZZZZ' not found ..."]} for an invalid ticker. */
export async function sendConversationMessage(
  conversationId: number,
  message: string,
  options: SendMessageOptions = {},
): Promise<AssistantMessage> {
  const body: Record<string, string> = { message };
  if (options.modelId) body.model_id = options.modelId;
  if (options.ticker) body.ticker = options.ticker;

  const res = await apiFetch(`/assistant/conversations/${conversationId}/messages/`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return parseJsonOrThrow<AssistantMessage>(res);
}

/** Approve or deny a proposed action (e.g. ingesting a filing). This only
 *  kicks off the work (or records the decline) -- the real outcome arrives
 *  later over the socket as assistant.action_complete. 404s if the action
 *  was already resolved (e.g. a double-clicked confirm). */
export async function respondToPendingAction(
  conversationId: number,
  pendingActionId: number,
  approved: boolean,
): Promise<void> {
  const res = await apiFetch(`/assistant/conversations/${conversationId}/pending-actions/${pendingActionId}/`, {
    method: "POST",
    body: JSON.stringify({ approved }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body);
  }
}
