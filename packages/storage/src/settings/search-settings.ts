import type { DatabaseSync } from "node:sqlite";
import { type SearchConfig, SearchConfigSchema } from "@pibot/protocol-base";
import { transaction } from "../database/database.ts";

export class SearchSettingsRepo {
  constructor(private readonly db: DatabaseSync) {}
  keyless(provider: "keyless" | "duckduckgo" | "bing" = "keyless"): SearchConfig {
    const disclosed =
      provider === "keyless"
        ? this.recipientDisclosed("duckduckgo") && this.recipientDisclosed("bing")
        : this.recipientDisclosed(provider);
    return { provider, configured: true, disclosed };
  }
  duckduckgo(): Extract<SearchConfig, { provider: "duckduckgo" }> {
    return {
      provider: "duckduckgo",
      configured: true,
      disclosed: this.recipientDisclosed("duckduckgo"),
    };
  }
  recipientDisclosed(provider: "duckduckgo" | "bing") {
    return (
      this.db.prepare("SELECT value FROM settings WHERE key=?").get(`search:${provider}:disclosed`)
        ?.value === "true"
    );
  }
  get(): SearchConfig | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key='search'").get();
    if (!row) return this.keyless();
    const config = SearchConfigSchema.parse(JSON.parse(String(row.value)));
    return config.provider === "keyless" ||
      config.provider === "duckduckgo" ||
      config.provider === "bing"
      ? this.keyless(config.provider)
      : config;
  }
  private write(config: SearchConfig) {
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES ('search',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(config));
    return config;
  }
  set(input: SearchConfig): SearchConfig {
    const value = SearchConfigSchema.parse(input);
    return transaction(this.db, () => {
      const old = this.get();
      const same =
        old?.provider === value.provider &&
        (value.provider !== "searxng" ||
          (old.provider === "searxng" && old.baseUrl === value.baseUrl));
      return this.write(
        value.provider === "keyless" || value.provider === "duckduckgo" || value.provider === "bing"
          ? this.keyless(value.provider)
          : { ...value, disclosed: same ? old.disclosed : false },
      );
    });
  }
  disclose(provider: Exclude<SearchConfig["provider"], "keyless">): SearchConfig {
    return transaction(this.db, () => {
      const config = this.get();
      if (!config) throw new TypeError("Search service changed");
      if (provider === "duckduckgo" || provider === "bing") {
        this.db
          .prepare(
            "INSERT INTO settings(key,value) VALUES (?,'true') ON CONFLICT(key) DO UPDATE SET value='true'",
          )
          .run(`search:${provider}:disclosed`);
        // Mirror effective consent in the selected JSON even if the request later fails.
        // An API config with a missing credential falls back without approving that API recipient.
        return config.provider === "keyless" ||
          config.provider === "duckduckgo" ||
          config.provider === "bing"
          ? this.write(this.keyless(config.provider))
          : config;
      }
      if (config.provider !== provider) throw new TypeError("Search service changed");
      return this.write({ ...config, disclosed: true });
    });
  }
  remove(): boolean {
    return this.db.prepare("DELETE FROM settings WHERE key='search'").run().changes > 0;
  }
}
