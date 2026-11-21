export function createEnvReader(
  originalEnv: Readonly<NodeJS.ProcessEnv>,
  allowedNames: readonly string[],
  platform: NodeJS.Platform,
) {
  const values = new Map<string, string>();
  for (const name of allowedNames) {
    const key =
      platform === "win32"
        ? Object.keys(originalEnv).find((key) => key.toUpperCase() === name.toUpperCase())
        : name;
    const value = key === undefined ? undefined : originalEnv[key];
    if (value) values.set(name, value);
  }
  return {
    detect: () => [...values.keys()],
    read: (name: string) => values.get(name),
  };
}
