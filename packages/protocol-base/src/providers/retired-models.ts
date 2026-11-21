/**
 * Models a provider has shut down that pi's pinned catalog still lists. Picking one fails every
 * request with 404, and the welcome key test used to pick the cheapest of them. Source: Google's
 * Gemini API deprecations page, shutdown dates up to 2026-11-20.
 */
const RETIRED: Readonly<Record<string, ReadonlySet<string>>> = {
  google: new Set([
    "gemini-3-pro-preview",
    "gemini-3.1-flash-lite-preview",
    "gemini-2.5-computer-use-preview-10-2025",
    "gemini-2.5-pro-preview-03-25",
    "gemini-2.5-pro-preview-05-06",
    "gemini-2.5-pro-preview-06-05",
    "gemini-2.5-flash-lite-preview-09-2025",
    "gemini-2.5-flash-preview-05-20",
    "gemini-2.5-flash-preview-09-2025",
    "gemini-2.0-flash",
    "gemini-2.0-flash-001",
    "gemini-2.0-flash-lite",
    "gemini-2.0-flash-lite-001",
    "gemini-2.0-flash-lite-preview",
    "gemini-2.0-flash-lite-preview-02-05",
    "gemini-live-2.5-flash-preview",
    "gemini-2.0-flash-live-001",
    "gemini-3.1-flash-image-preview",
    "gemini-3-pro-image-preview",
    "gemini-2.5-flash-image-preview",
    "gemini-2.0-flash-preview-image-generation",
    "imagen-4.0-generate-001",
    "imagen-4.0-ultra-generate-001",
    "imagen-4.0-fast-generate-001",
    "imagen-4.0-generate-preview-06-06",
    "imagen-4.0-ultra-generate-preview-06-06",
    "imagen-3.0-generate-002",
  ]),
};

export function isRetiredModel(provider: string, id: string): boolean {
  return RETIRED[provider]?.has(id) ?? false;
}
