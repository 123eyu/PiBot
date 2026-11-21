/** Stderr is untrusted content: redacting known keys alone cannot remove contact/file text. */
export function diagnosticStderr(tail: string): string {
  const tokens =
    tail
      .slice(-8192)
      .match(
        /\b(?:EACCES|EPERM|ENOENT|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|SIGTERM|SIGKILL|SIGSEGV|mach-lookup|file-read-data|file-write-create|network-outbound|sandbox-exec|sandbox_init|Operation not permitted|Permission denied|No such file or directory)\b/g,
      ) ?? [];
  // Only fixed diagnostic markers survive; arbitrary application text is never logged.
  return [...new Set(tokens)].join("\n").slice(-2048) || "[stderr content omitted]";
}

export function observeStderr(
  stream: {
    stderrTail(): string;
    onClose(listener: () => void): () => void;
    close(): Promise<void>;
  },
  report: (tail: string) => void,
) {
  let expected = false;
  let reported = false;
  const failed = () => {
    if (reported) return;
    const tail = stream.stderrTail();
    if (!tail) return;
    reported = true;
    report(diagnosticStderr(tail));
  };
  const unsubscribe = stream.onClose(() => {
    if (!expected) failed();
  });
  return {
    failed,
    async close() {
      expected = true;
      try {
        await stream.close();
        unsubscribe();
      } catch (error) {
        // A failed drain still owns the stream and its listener; a retry releases both.
        failed();
        throw error;
      }
    },
  };
}
