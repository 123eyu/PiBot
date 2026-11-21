/**
 * ACP traffic carries the agent's account (T0: Claude's auth notification names the e-mail and
 * organisation). Pi Bot never stores those notifications; any agent text that does reach a log
 * line or an audit summary passes through this first.
 */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function maskAccount(text: string): string {
  return text.replace(EMAIL, "<email>");
}
