/** A masked result is a projection, never evidence that the source contains the mask literally. */
export function redactedToolText(text: string, redact: (text: string) => string): string {
  const safe = redact(text);
  return safe !== text || safe.includes("[REDACTED]") || /\[密钥 [^\]]+\]/u.test(safe)
    ? `${safe}\n内容已按密钥规则隐藏；隐藏标记不代表原文件的字面内容。 / Content is hidden by secret-redaction rules; masking markers do not establish the original file's literal content.`
    : safe;
}
