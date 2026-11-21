/** Platform-specific launcher the browser starts as Pi Bot's native host. */
export interface BrowserExtensionPlatform {
  launch(
    browser: "chrome" | "edge" | "brave" | "chromium" | "firefox",
    signal?: AbortSignal,
  ): Promise<void>;
  /**
   * Browsers start the manifest's `path` with only their own arguments, so a small script carries
   * ours: which data folder (this instance) and, in development, the entry script.
   */
  createLauncher(options: {
    dataDir: string;
    executable: string;
    /** Development only: Electron needs the app's entry before our flag. */
    entry?: string;
  }): Promise<string>;
  removeLauncher(path: string): Promise<void>;
}
