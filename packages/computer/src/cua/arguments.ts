/** Native generic tools parse u64 JSON numbers; crossing our IPC still uses decimal strings. */
export function serializeCuaArgs(args: Record<string, unknown>): string {
  // Node/Electron support raw JSON; ES2023's TypeScript declarations predate this API.
  const json = JSON as typeof JSON & { rawJSON(text: string): unknown };
  return JSON.stringify(args, (_key, value: unknown) =>
    typeof value === "bigint" ? json.rawJSON(value.toString()) : value,
  );
}
