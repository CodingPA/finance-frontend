import { useEffect, useState } from "react";
import { realtime, type WsStatus } from "../lib/ws";

export function useRealtimeStatus(): WsStatus {
  const [status, setStatus] = useState<WsStatus>("idle");
  useEffect(() => realtime.onStatusChange(setStatus), []);
  return status;
}
