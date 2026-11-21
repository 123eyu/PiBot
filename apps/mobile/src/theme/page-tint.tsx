import { createContext, type ReactNode, useContext } from "react";

/**
 * The page colour (an avatar colour name) for everything inside a page that does not take it as
 * a prop: the header wash, chosen checks, the composer. A Bot's pages set its colour.
 */
const Context = createContext<string>("violet");
export function PageTint({ name, children }: { name: string | undefined; children: ReactNode }) {
  const parent = useContext(Context);
  return <Context.Provider value={name ?? parent}>{children}</Context.Provider>;
}
export function usePageTint() {
  return useContext(Context);
}
