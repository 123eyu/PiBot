/** User addresses without a scheme mean HTTPS; the host still validates the target. */
export function normalizeAddress(input: string) {
  const value = input.trim();
  return /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
}
