import { createRedactor, withNamedRedaction } from "@pibot/secrets";

const MAX_VALUES = 1024;
const MAX_BYTES = 1024 * 1024;

export interface RunnerRedactor {
  add(value: string): void;
  register(values: readonly string[]): () => void;
  redact(text: string): string;
  stream(): { push(text: string): string; finish(): string };
}

function variants(values: readonly string[]) {
  const result = new Set<string>();
  for (const value of values) {
    if (!value || value.includes("\0")) continue;
    result.add(value);
    result.add(JSON.stringify(value).slice(1, -1));
  }
  return [...result];
}

export function createRunnerRedactor(): RunnerRedactor {
  const references = new Map<string, number>();
  const originals = new Map<string, number>();
  let bytes = 0;
  let shared = withNamedRedaction(createRedactor());
  const rebuild = () => {
    shared = withNamedRedaction(createRedactor());
    // Named registration also protects short values that the anonymous compatibility API skips.
    for (const value of originals.keys()) shared.addNamed("RUNNER_SECRET", value);
  };
  const register = (input: readonly string[]) => {
    const values = [...new Set(input.filter((value) => value && !value.includes("\0")))];
    const additions = variants(values);
    const newValues = additions.filter((value) => !references.has(value));
    const newBytes = newValues.reduce((total, value) => total + Buffer.byteLength(value), 0);
    if (references.size + newValues.length > MAX_VALUES || bytes + newBytes > MAX_BYTES)
      throw new Error("runner_redactor_capacity");
    for (const value of additions) references.set(value, (references.get(value) ?? 0) + 1);
    const originalsChanged = values.some((value) => !originals.has(value));
    for (const value of values) originals.set(value, (originals.get(value) ?? 0) + 1);
    bytes += newBytes;
    if (originalsChanged) rebuild();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      let changed = false;
      for (const value of values) {
        const count = originals.get(value) ?? 0;
        if (count > 1) originals.set(value, count - 1);
        else {
          originals.delete(value);
          changed = true;
        }
      }
      for (const value of additions) {
        const count = references.get(value);
        if (count === undefined) continue;
        if (count > 1) references.set(value, count - 1);
        else {
          references.delete(value);
          bytes -= Buffer.byteLength(value);
        }
      }
      if (changed) rebuild();
    };
  };
  return {
    add(value) {
      register([value]);
    },
    register,
    redact: (text) => shared.redact(text),
    // Execution owns each stream until finish; a lease release cannot weaken its snapshot.
    stream: () => shared.stream(),
  };
}
