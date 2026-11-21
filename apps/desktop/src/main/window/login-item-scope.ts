export interface LoginItemScope {
  dev: boolean;
  env: Readonly<NodeJS.ProcessEnv>;
}

// main/index.ts resolves the platform default exactly when no override is present. Even an
// explicit override to that same directory must not gain authority over the user's login items.
export function loginItemSyncEnabled({ dev, env }: LoginItemScope): boolean {
  return !dev && env.PIBOT_DATA_DIR === undefined;
}

export function createLoginItemSync(
  scope: LoginItemScope,
  synchronize: (openAtLogin: boolean) => Promise<void>,
) {
  const enabled = loginItemSyncEnabled(scope);
  return async (openAtLogin: boolean): Promise<void> => {
    if (enabled) await synchronize(openAtLogin);
  };
}

export function desktopLaunchEnvironment(scope: LoginItemScope, dataDir: string) {
  // Propagating the resolved default as an override would disable login sync in the next role.
  // Explicit/test roots still travel canonically so GUI and owner retain the same writer root.
  return loginItemSyncEnabled(scope) ? { ...scope.env } : { ...scope.env, PIBOT_DATA_DIR: dataDir };
}
