/** Feedback includes the public page location, never URL credentials, query tokens or fragments. */
export function publicBrowserAddress(value: string) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}
