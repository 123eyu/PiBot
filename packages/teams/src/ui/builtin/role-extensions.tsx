import { createContext, type ReactNode, useContext } from "react";

/**
 * A category of the "New Bot" role browser that another capability fills (external agents).
 * The desktop shell provides the list, so the browser works the same in every host that shows
 * it, and teams depends on no other capability.
 */
export interface RoleCategoryExtension {
  id: string;
  label: string;
  /** Shown instead of the role grid while this category is selected. */
  render(): ReactNode;
}

const RoleExtensionsContext = createContext<readonly RoleCategoryExtension[]>([]);

export function TeamsUiProvider({
  roleCategories,
  children,
}: {
  roleCategories: readonly RoleCategoryExtension[];
  children: ReactNode;
}) {
  return (
    <RoleExtensionsContext.Provider value={roleCategories}>
      {children}
    </RoleExtensionsContext.Provider>
  );
}

export function useRoleCategoryExtensions() {
  return useContext(RoleExtensionsContext);
}
