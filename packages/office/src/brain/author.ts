// Author metadata must stay readable and cannot contain invisible display controls.
export function officeAuthor(botName: string) {
  const name = Array.from(
    botName
      .normalize("NFC")
      .replace(/[\p{Cc}\p{Cf}]/gu, "")
      .replace(/\s+/gu, " ")
      .trim(),
  )
    .slice(0, 64)
    .join("")
    .trim();
  return `Pi Bot · ${name || "Bot"}`;
}
