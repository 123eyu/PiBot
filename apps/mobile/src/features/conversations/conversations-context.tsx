import { createContext, type ReactNode, useContext } from "react";
import { useConversationsState } from "./use-conversations.ts";

const Context = createContext<ReturnType<typeof useConversationsState> | null>(null);
/** One conversation list for the chat tab, its badge and the chat page header. */
export function ConversationsProvider({ children }: { children: ReactNode }) {
  return <Context.Provider value={useConversationsState()}>{children}</Context.Provider>;
}
export function useConversations() {
  const value = useContext(Context);
  if (!value) throw new Error("conversations_unavailable");
  return value;
}
