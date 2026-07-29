// Bell + dropdown for the durable notifications feed. Wiki's daily
// change-detection job is the only producer today (wiki.page_changed), but
// the mechanism is generic -- this just renders whatever's unacknowledged.
//
// Unread notifications are fetched once on mount (covers whatever was
// already sitting there) and merged with `notification.new` events off the
// realtime socket, which fire both for genuinely new notifications and for
// the reconnect backlog flush -- dedupe by id either way. "Seen" is defined
// as dismissed: a notification stays in the list (and keeps being
// redelivered on reconnect) until the user explicitly acks it.

import { useEffect, useState } from "react";
import { listNotifications, ackNotification, type Notification } from "../lib/notifications";
import { formatDateTime } from "../lib/format";
import { realtime } from "../lib/ws";

export function NotificationBell() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listNotifications(true)
      .then((all) => {
        if (!cancelled) setNotifications(all);
      })
      .catch(() => {
        // Best-effort -- the bell just shows nothing if this fails, no
        // dedicated error UI for a background feed like this.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return realtime.on("notification.new", (message) => {
      const id = message.id;
      const title = message.title;
      const body = message.body;
      const notificationType = message.notification_type;
      const createdAt = message.created_at;
      if (typeof id !== "number" || typeof title !== "string" || typeof body !== "string") return;
      const n: Notification = {
        id,
        notification_type: typeof notificationType === "string" ? notificationType : "",
        title,
        body,
        payload: (message.payload as Record<string, unknown>) ?? {},
        created_at: typeof createdAt === "string" ? createdAt : new Date().toISOString(),
        // Not sent on the WS event -- a just-arrived notification.new is
        // definitionally unacknowledged.
        acknowledged_at: null,
      };
      setNotifications((prev) => (prev.some((existing) => existing.id === n.id) ? prev : [n, ...prev]));
    });
  }, []);

  const handleDismiss = async (id: number) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
    try {
      await ackNotification(id);
    } catch {
      // Best-effort: if the ack fails it'll just come back on next
      // reconnect/poll rather than staying stuck invisible.
    }
  };

  return (
    <div className="notif-bell">
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="true"
        aria-expanded={open}
      >
        Notifications{notifications.length > 0 ? ` (${notifications.length})` : ""}
      </button>
      {open && (
        <div className="notif-menu elev-md">
          {loading && <div className="notif-empty text-muted">Loading…</div>}
          {!loading && notifications.length === 0 && <div className="notif-empty text-muted">No new notifications</div>}
          {!loading &&
            notifications.map((n) => (
              <div className="notif-item" key={n.id}>
                <div className="notif-item-title">{n.title}</div>
                <p className="card-body">{n.body}</p>
                <div className="card-meta">{formatDateTime(n.created_at)}</div>
                <button type="button" className="btn btn-ghost btn-icon-sm" onClick={() => handleDismiss(n.id)}>
                  Dismiss
                </button>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
