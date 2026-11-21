// Share format recognition with named/stream redaction so overlapping matches stay atomic.
export const keyPattern =
  /(?<![A-Za-z0-9_-])(?:sk-(?:ant-)?[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{35,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gsk_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9_-]{24,})(?![A-Za-z0-9_-])/g;
export const keyPrefixes = [
  "sk-",
  "sk-ant-",
  "xai-",
  "AIza",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
  "github_pat_",
  "gsk_",
  "hf_",
  "xoxb-",
  "xoxa-",
  "xoxp-",
  "xoxr-",
  "xoxs-",
] as const;
