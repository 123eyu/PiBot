import {
  AppReleaseSchema,
  type KernelMethodResults,
  ReleaseVersionSchema,
  updateUserAgent,
} from "@pibot/protocol-base";

export const UPDATE_MANIFEST_URL = "https://pibot.space/updates/stable.json";
/** A manual check only: neither the manifest nor a version comparison can start an installer. */
export class AppUpdates {
  private pending?: Promise<KernelMethodResults["app.checkUpdates"]>;
  constructor(
    private readonly options: {
      fetch: typeof fetch;
      version: string;
      platform: string;
      arch: string;
      signal: AbortSignal;
    },
  ) {}
  check(): Promise<KernelMethodResults["app.checkUpdates"]> {
    if (this.pending) return this.pending;
    const work = this.load();
    this.pending = work;
    void work
      .finally(() => {
        if (this.pending === work) this.pending = undefined;
      })
      .catch(() => {
        /* The caller receives cancellation; cleanup cannot create an unhandled rejection. */
      });
    return work;
  }
  private async load(): Promise<KernelMethodResults["app.checkUpdates"]> {
    const currentVersion = this.options.version.split(":")[0] ?? this.options.version;
    const signal = AbortSignal.any([this.options.signal, AbortSignal.timeout(20_000)]);
    try {
      const response = await this.options.fetch(UPDATE_MANIFEST_URL, {
        signal,
        redirect: "error",
        credentials: "omit",
        headers: {
          Accept: "application/json",
          "User-Agent": updateUserAgent(currentVersion, this.options.platform, this.options.arch),
        },
      });
      if ([204, 404, 410].includes(response.status)) {
        await response.body?.cancel();
        return { status: "not_ready", currentVersion };
      }
      if (
        !response.ok ||
        !response.body ||
        !response.headers.get("content-type")?.includes("application/json")
      ) {
        await response.body?.cancel();
        return { status: "unavailable", currentVersion };
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 64 * 1024) {
            await reader.cancel();
            return { status: "unavailable", currentVersion };
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const release = AppReleaseSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const current = ReleaseVersionSchema.safeParse(currentVersion);
      if (!current.success) return { status: "unavailable", currentVersion };
      const remote = release.version.split(".").map(BigInt),
        local = current.data.split(".").map(BigInt);
      let newer = false;
      for (let i = 0; i < 3; i++) {
        if (remote[i] !== local[i]) {
          newer = (remote[i] ?? 0n) > (local[i] ?? 0n);
          break;
        }
      }
      if (!newer) return { status: "current", currentVersion, version: release.version };
      const key = `${this.options.platform}-${this.options.arch}` as keyof typeof release.downloads;
      const url = release.downloads[key];
      return url
        ? { status: "available", currentVersion, version: release.version, url }
        : { status: "no_download", currentVersion, version: release.version };
    } catch {
      this.options.signal.throwIfAborted();
      return { status: "unavailable", currentVersion };
    }
  }
}
