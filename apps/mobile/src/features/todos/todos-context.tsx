import { createContext, type ReactNode, useContext } from "react";
import { useTodosState } from "./use-todos.ts";

const Context = createContext<ReturnType<typeof useTodosState> | null>(null);
/**
 * Mounted with the other providers, not on the tab: edits made offline are replayed on reconnect
 * even when the To-dos tab is not opened again.
 */
export function TodosProvider({ children }: { children: ReactNode }) {
  return <Context.Provider value={useTodosState()}>{children}</Context.Provider>;
}
export function useTodos() {
  const value = useContext(Context);
  if (!value) throw new Error("todos_unavailable");
  return value;
}
