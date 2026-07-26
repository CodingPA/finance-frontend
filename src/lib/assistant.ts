// Client for the chat assistant. Conversations persist server-side; each
// only carries its own last 10 messages as context (no injected data yet).
// A sent message's reply never comes back on the POST -- it streams over
// the user's realtime socket as assistant.token / assistant.complete /
// assistant.error, tagged with conversation_id (see lib/ws.ts).

import { apiFetch, parseJsonOrThrow, ApiError } from "./api";

export interface AssistantModel {
  model_id: string;
  display_name: string;
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
  model_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
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

/** Queues the assistant run and returns the user message row you just sent
 *  (202) -- safe to append immediately. The reply streams over the socket. */
export async function sendConversationMessage(
  conversationId: number,
  message: string,
  modelId?: string,
): Promise<AssistantMessage> {
  const res = await apiFetch(`/assistant/conversations/${conversationId}/messages/`, {
    method: "POST",
    body: JSON.stringify(modelId ? { message, model_id: modelId } : { message }),
  });
  return parseJsonOrThrow<AssistantMessage>(res);
}
