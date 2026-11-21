import { createContext, useContext } from "react";

/**
 * Shared actions (e.g. 在访达中显示) lead with an IconTile when they sit in a PopupMenu and
 * keep their plain icon elsewhere, without every caller passing a flag.
 */
export const InPopupMenu = createContext(false);
export const useInPopupMenu = () => useContext(InPopupMenu);
