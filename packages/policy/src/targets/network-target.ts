export function networkTarget(value: string): string | undefined {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return /^(?:[^@\s]+@)?([\w.-]+):[^/]/.exec(value)?.[1]?.toLowerCase();
  }
}
