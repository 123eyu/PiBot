import { spawn } from "node:child_process";
import { legacyDecoded, legacyEncoded } from "./legacy-format.ts";

/** Bounded compatibility read for libsecret's old application/service/name attributes. */
export async function readLegacyLinux(service: string, name: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const attributes = [
    "application",
    "secrets",
    "service",
    legacyEncoded(service),
    "name",
    legacyEncoded(name),
  ];
  return new Promise<string | null>((resolve, reject) => {
    const child = spawn(
      "/usr/bin/secret-tool",
      ["search", "--all", "--unlock", "--", ...attributes],
      {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "",
      err = "",
      failed = false;
    const stop = () => {
      failed = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(stop, 10_000);
    signal.addEventListener("abort", stop, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (Buffer.byteLength(out) > 32_768) stop();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
      if (Buffer.byteLength(err) > 4096) stop();
    });
    child.once("error", (error) => {
      cleanup();
      const code = (error as NodeJS.ErrnoException).code;
      reject(
        new Error(
          code === "ENOENT"
            ? "legacy_credentials_unavailable"
            : code === "EACCES" || code === "EPERM"
              ? "legacy_credentials_access_denied"
              : "legacy_credentials_failed",
        ),
      );
    });
    child.once("close", (code) => {
      cleanup();
      try {
        signal.throwIfAborted();
        if (failed || code !== 0) throw new Error("legacy_credentials_failed");
        if (!out && !err) return resolve(null);
        const allowed = new Set(
          [0, 2, 4].map((i) => `attribute.${attributes[i]} = ${attributes[i + 1]}\n`),
        );
        if ((err.match(/[^\n]*\n|[^\n]+$/g) ?? []).some((line) => !allowed.has(line)))
          throw new Error("legacy_credentials_failed");
        const record =
          /^\[[^\r\n\]]+\]\nlabel = [^\r\n]*\nsecret = (secrets:v1:[A-Za-z0-9+/=]*)\ncreated = [^\r\n]*\nmodified = [^\r\n]*\n(?:schema = [^\r\n]*\n)?$/;
        const match = record.exec(out);
        // Ambiguous or locked records must not look like an absent identity.
        if (!match?.[1]) throw new Error("legacy_credentials_failed");
        resolve(legacyDecoded(match[1]));
      } catch {
        reject(new Error("legacy_credentials_failed"));
      }
    });
  });
}

/** Delete compatibility items too, otherwise a later lookup could resurrect a deleted native entry. */
export async function deleteLegacyLinux(service: string, name: string, signal: AbortSignal) {
  if ((await readLegacyLinux(service, name, signal)) === null) return;
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "/usr/bin/secret-tool",
      [
        "clear",
        "--",
        "application",
        "secrets",
        "service",
        legacyEncoded(service),
        "name",
        legacyEncoded(name),
      ],
      {
        shell: false,
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      child.kill("SIGKILL");
    }, 10_000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("legacy_credentials_failed"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && !expired) resolve();
      else reject(new Error("legacy_credentials_failed"));
    });
  });
  if ((await readLegacyLinux(service, name, signal)) !== null)
    throw new Error("legacy_credentials_failed");
}
