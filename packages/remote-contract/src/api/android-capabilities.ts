/** Trusted references only; native readiness and permission never come from a peer's schema. */
export const ANDROID_PHONE_CAPABILITIES = [
  {
    id: "phone.notifications",
    version: 1,
    key: "notifications",
    name: { zh: "通知监听", en: "Notifications" },
  },
  { id: "phone.calls", version: 1, key: "calls", name: { zh: "通话记录", en: "Call history" } },
  {
    id: "phone.ui",
    version: 1,
    key: "ui",
    name: { zh: "无障碍操作", en: "Accessibility actions" },
  },
  { id: "phone.shell", version: 1, key: "shell", name: { zh: "Shizuku", en: "Shizuku" } },
] as const;

export const phoneCapabilityForMethod = (method: string): string =>
  method === "phoneData.smsCode"
    ? "phone.sms"
    : method === "phoneData.calls"
      ? "phone.calls"
      : method === "phoneData.notifications"
        ? "phone.notifications"
        : "phone.media";

/**
 * Only these existed before capability manifests. Legacy sessions (no negotiated manifest)
 * and legacy switch migration cover them alone; newer capabilities need a real manifest and an
 * explicit enabled list, and start off.
 */
export const LEGACY_PHONE_CAPABILITIES: ReadonlySet<string> = new Set(["phone.media", "phone.sms"]);
export const isLegacyPhoneMethod = (method: string) =>
  LEGACY_PHONE_CAPABILITIES.has(phoneCapabilityForMethod(method));
