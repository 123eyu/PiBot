/** Saved passwords are the last section of permissions; remote is a capability page. */
export const SETTINGS_SECTIONS = [
  "general",
  "models",
  "permissions",
  "computer",
  "routines",
  "remote",
  "browser",
] as const;
export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number];
