// Client for the durable notifications feed (`notifications` app) -- the
// REST-side view of what also arrives live over the realtime socket as
// `notification.new` (see lib/ws.ts). Wiki's daily change-detection job is
// the first producer (wiki.page_changed), but the shape is generic.
//
// An unacknowledged notification keeps being redelivered over the socket on
// every reconnect, so anything the user has actually seen must be ack'd.

import { apiFetch, parseJsonOrThrow } from "./api";

export interface Notification {
  id: number;
  notification_type: string;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  created_at: string;
  acknowledged_at: string | null;
}

/** Newest first. Pass `unreadOnly` to fetch only unacknowledged ones. */
export async function listNotifications(unreadOnly = false): Promise<Notification[]> {
  const res = await apiFetch(`/notifications/${unreadOnly ? "?unread=1" : ""}`);
  return parseJsonOrThrow<Notification[]>(res);
}

/** Idempotent -- acking an already-acked notification just returns it as-is. */
export async function ackNotification(id: number): Promise<Notification> {
  const res = await apiFetch(`/notifications/${id}/ack/`, { method: "POST" });
  return parseJsonOrThrow<Notification>(res);
}
