// Client for the chat assistant (first slice: stateless, no tools). The
// POST only queues the run -- the actual reply streams over the user's
// realtime socket as assistant.token / assistant.complete / assistant.error
// (see lib/ws.ts and docs/websockets.md), not over this HTTP response.

import { apiFetch, parseJsonOrThrow, ApiError } from "./api";

export interface AssistantModel {
  model_id: string;
  display_name: string;
  is_default: boolean;
}

/** Admin-managed model catalog -- the same list `model_id` validates against. */
export async function listAssistantModels(): Promise<AssistantModel[]> {
  const res = await apiFetch("/assistant/models/");
  return parseJsonOrThrow<AssistantModel[]>(res);
}

/** Queues the assistant run. Resolves once accepted (202) -- the reply itself
 *  arrives later over the websocket. Omit `modelId` to use the admin-flagged default. */
export async function sendAssistantMessage(message: string, modelId?: string): Promise<void> {
  const res = await apiFetch("/assistant/message/", {
    method: "POST",
    body: JSON.stringify(modelId ? { message, model_id: modelId } : { message }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body);
  }
}
