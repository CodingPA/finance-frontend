// Just the open/closed signal for the chat assistant drawer -- shared
// because the button that opens it now lives in two different places
// (ChatAssistant's own locked corner button on desktop, BottomNav's tab on
// mobile) while the drawer/conversation state itself stays inside
// ChatAssistant.

import { createContext, useContext, useState, type ReactNode } from "react";

interface ChatContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <ChatContext.Provider value={{ open, setOpen }}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used within a ChatProvider");
  return ctx;
}
