import type { MobileKey } from "../messages.ts";

/**
 * Android has no Face ID; its unlock is a fingerprint or the screen lock. These replace the
 * iOS wording on Android only, key by key, so neither platform reads the other's terms.
 */
export const androidZh: Partial<Record<MobileKey, string>> = {
  faceTitle: "用指纹或锁屏确认",
  faceSetting: "危险操作前验证指纹或锁屏",
  retryFiles: "还会把 {count} 个文件恢复到这条消息之前，恢复前用指纹或锁屏确认。",
  widenNote: "放宽权限前要先验证指纹或锁屏",
  changesDesktop: "点文件看逐行差异和文件内容；撤回前先用指纹或锁屏确认。",
  restoreHint: "文件会恢复到 Bot 改动前。撤回前用指纹或锁屏确认。",
  endpointsBiometricHint: "开启或扩大范围需要指纹或锁屏确认。",
};
export const androidEn: Partial<Record<MobileKey, string>> = {
  faceTitle: "Confirm with fingerprint or screen lock",
  faceSetting: "Fingerprint or screen lock before risky actions",
  retryFiles:
    "{count} files are also restored to before this message. Confirm with your fingerprint or screen lock before restoring.",
  widenNote: "Loosening a permission asks for your fingerprint or screen lock first",
  changesDesktop:
    "Tap a file for its line-by-line diff and contents; restoring asks for your fingerprint or screen lock first.",
  restoreHint:
    "The file goes back to how it was before the Bot changed it. Confirm with your fingerprint or screen lock first.",
  endpointsBiometricHint: "Turning on or widening a scope needs your fingerprint or screen lock.",
};
