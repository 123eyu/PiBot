import { StringDecoder } from "node:string_decoder";
import type { RunnerRedactor } from "./redactor.ts";

export function takeEnvironmentPassphrase(redactor: RunnerRedactor) {
  const value = process.env.PIBOT_RUNNER_PASSPHRASE;
  delete process.env.PIBOT_RUNNER_PASSPHRASE;
  if (value) redactor.add(value);
  return value;
}

export async function readPassphrase(
  environmentValue: string | undefined,
  signal: AbortSignal,
  redactor: RunnerRedactor,
) {
  if (environmentValue) return environmentValue;
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error("passphrase_required");
  const input = process.stdin;
  process.stderr.write("Pi Bot Runner passphrase: ");
  return new Promise<string>((resolve, reject) => {
    let value = "";
    let settled = false;
    let raw = false;
    const decoder = new StringDecoder("utf8");
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      input.off("data", onData);
      signal.removeEventListener("abort", onAbort);
      if (raw) input.setRawMode(false);
      input.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else if (!value) reject(new Error("passphrase_required"));
      else {
        try {
          redactor.add(value);
          resolve(value);
        } catch (redactorError) {
          reject(redactorError);
        }
      }
    };
    const onAbort = () => finish(signal.reason);
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) return finish(new Error("cancelled"));
        if (byte === 13 || byte === 10) return finish();
        if (byte === 8 || byte === 127) value = Array.from(value).slice(0, -1).join("");
        else if (value.length < 4096) value += decoder.write(Buffer.from([byte]));
      }
    };
    input.on("data", onData);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) return finish(signal.reason);
    input.setRawMode(true);
    raw = true;
    if (settled || signal.aborted) return finish(signal.reason);
    input.resume();
  });
}
