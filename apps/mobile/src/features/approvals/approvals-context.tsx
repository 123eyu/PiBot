import { createContext, type ReactNode, useContext } from "react";
import { useApprovalsState } from "./use-approvals.ts";

const Context = createContext<ReturnType<typeof useApprovalsState> | null>(null);
export function ApprovalsProvider({ children }: { children: ReactNode }) {
  return <Context.Provider value={useApprovalsState()}>{children}</Context.Provider>;
}
export function useApprovals() {
  const value = useContext(Context);
  if (!value) throw new Error("approvals_unavailable");
  return value;
}
