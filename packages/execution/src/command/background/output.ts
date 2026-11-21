import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { ExecRedactor } from "../../core/types.ts";
import { PermissionErrors } from "../output-notices.ts";
import { OutputProgress } from "../output-progress.ts";

/** Keep classification and progress independent of the bounded, redacted recent-output tail. */
export function createBackgroundOutput(
  stdout: Readable | null,
  stderr: Readable | null,
  redactor: ExecRedactor,
  write: (text: string) => void,
) {
  let tail = "";
  let failed = false;
  let stderrEnded = false;
  let permissionOnly = false;
  const permissions = new PermissionErrors();
  const progress = new OutputProgress();
  const flushers: (() => void)[] = [];
  const append = (text: string) => {
    if (!text) return;
    tail = (tail + text).slice(-64 * 1024);
    write(text);
  };
  for (const source of [stdout, stderr]) {
    if (!source) continue;
    const decoder = new StringDecoder("utf8");
    const stream = redactor.stream();
    const capture = (text: string) => {
      if (source === stderr) permissions.push(text);
      progress.push(text);
      append(text);
    };
    let done = false;
    const flush = () => {
      if (done) return;
      done = true;
      capture(stream.push(decoder.end()));
      capture(stream.finish());
    };
    flushers.push(flush);
    source.on("data", (chunk: Buffer) => capture(stream.push(decoder.write(chunk))));
    source.once("end", () => {
      if (source === stderr) stderrEnded = true;
      flush();
    });
    source.once("error", () => {
      failed = true;
      flush();
    });
  }
  return {
    appendDiagnostic: append,
    get lines() {
      return progress.lines;
    },
    get permissionOnly() {
      return permissionOnly;
    },
    text(maxChars: number) {
      return maxChars > 0 ? tail.slice(-maxChars) : "";
    },
    finish(permissionEligible: boolean) {
      for (const flush of flushers) flush();
      permissionOnly = permissionEligible && !failed && stderrEnded && permissions.finish();
    },
  };
}
