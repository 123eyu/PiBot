import { spawn } from "node:child_process";
import { legacyDecoded, legacyEncoded } from "./legacy-format.ts";
import { deleteLegacyLinux, readLegacyLinux } from "./linux-legacy.ts";
import { deleteLegacyWindows, readLegacyWindows } from "./windows-legacy.ts";

export type SystemCredentialFailure =
  | "unsupported"
  | "unavailable"
  | "access_denied"
  | "timeout"
  | "failed";

export class SystemCredentialError extends Error {
  constructor(readonly failure: SystemCredentialFailure) {
    super(`system_credential_${failure}`);
    this.name = "SystemCredentialError";
  }
}

async function linuxSecretServiceState(): Promise<
  "present" | "unavailable" | "access_denied" | "unknown"
> {
  const address = process.env.DBUS_SESSION_BUS_ADDRESS;
  if (!address) return "unavailable";
  if (Buffer.byteLength(address) > 4096) return "unknown";
  return new Promise((resolve) => {
    const child = spawn(
      "/usr/bin/gdbus",
      [
        "call",
        "--session",
        "--dest",
        "org.freedesktop.DBus",
        "--object-path",
        "/org/freedesktop/DBus",
        "--method",
        "org.freedesktop.DBus.NameHasOwner",
        "org.freedesktop.secrets",
      ],
      {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          DBUS_SESSION_BUS_ADDRESS: address,
          LC_ALL: "C",
          PATH: "/usr/bin:/bin",
        },
      },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (state: "present" | "unavailable" | "access_denied" | "unknown") => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(state);
    };
    const append = (current: string, chunk: Buffer) => {
      if (Buffer.byteLength(current) + chunk.length > 4096) {
        child.kill("SIGKILL");
        finish("unknown");
        return current;
      }
      return current + chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (error) => {
      const code = "code" in error ? error.code : undefined;
      finish(code === "EACCES" || code === "EPERM" ? "access_denied" : "unknown");
    });
    child.once("close", (code) => {
      if (code === 0 && stdout === "(true,)\n" && stderr === "") return finish("present");
      if (code === 0 && stdout === "(false,)\n" && stderr === "") return finish("unavailable");
      if (/permission denied|access denied/i.test(stderr)) return finish("access_denied");
      if (
        /cannot autolaunch|could not connect|error connecting|no such file|connection refused/i.test(
          stderr,
        )
      )
        return finish("unavailable");
      finish("unknown");
    });
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish("unknown");
    }, 3_000);
  });
}

function failure(error: unknown): SystemCredentialFailure {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  if (
    code === "EACCES" ||
    code === "EPERM" ||
    (error instanceof Error && error.message === "legacy_credentials_access_denied")
  )
    return "access_denied";
  if (error instanceof Error && error.message === "legacy_credentials_unavailable")
    return "unavailable";
  return "failed";
}

/** Native operations are drained before cancellation is returned; writes can already have committed. */
export function createSystemCredentialStore(service: string) {
  if (!service || Buffer.byteLength(service) > 256)
    throw new TypeError("Invalid system credential service");
  const entry = async (name: string) => {
    const { default: keyring } = await import("@napi-rs/keyring");
    if (!name || Buffer.byteLength(name) > 256) throw new TypeError("Invalid credential account");
    // Default entries only: withTarget reads wiped existing Windows credentials (windows-legacy.ts).
    if (process.platform === "darwin")
      return new keyring.AsyncEntry(legacyEncoded(service), legacyEncoded(name));
    return new keyring.AsyncEntry(service, name, { linux: { store: "secret-service" } });
  };
  const run = async <T>(signal: AbortSignal, mutation: boolean, work: () => Promise<T>) => {
    signal.throwIfAborted();
    // The native task has its own owner. Never race it and allow an identity fallback while it writes.
    const started = Date.now();
    try {
      const value = await work();
      if (!mutation) {
        signal.throwIfAborted();
        if (Date.now() - started > 30_000) throw new SystemCredentialError("timeout");
      }
      return value;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof SystemCredentialError) throw error;
      const state = process.platform === "linux" ? await linuxSecretServiceState() : "unknown";
      throw new SystemCredentialError(
        state === "unavailable" || state === "access_denied" ? state : failure(error),
      );
    }
  };
  return {
    get(name: string, signal: AbortSignal) {
      return run(signal, false, async () => {
        const item = await entry(name);
        const bytes = await item.getSecret();
        if (bytes !== null) {
          const buffer = Buffer.from(bytes);
          try {
            const text = buffer.toString("utf8");
            if (!Buffer.from(text).equals(buffer) || buffer.length > 4096)
              throw new Error("credential_encoding");
            return process.platform === "darwin" ? legacyDecoded(text) : text;
          } finally {
            buffer.fill(0);
            bytes.fill(0);
          }
        }
        // Identity verification belongs to the caller: a lookup must not migrate unverified bytes.
        if (process.platform === "linux") return readLegacyLinux(service, name, signal);
        if (process.platform === "win32") return readLegacyWindows(service, name, signal);
        return null;
      });
    },
    set(name: string, value: string, signal: AbortSignal) {
      return run(signal, true, async () => {
        const bytes = Buffer.from(process.platform === "darwin" ? legacyEncoded(value) : value);
        try {
          await (await entry(name)).setSecret(bytes);
        } finally {
          bytes.fill(0);
        }
      });
    },
    delete(name: string, signal: AbortSignal) {
      return run(signal, true, async () => {
        if (process.platform === "linux") await deleteLegacyLinux(service, name, signal);
        if (process.platform === "win32") await deleteLegacyWindows(service, name, signal);
        return (await entry(name)).deleteCredential();
      });
    },
  };
}

export type SystemCredentialStore = ReturnType<typeof createSystemCredentialStore>;
