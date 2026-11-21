/** Without title provenance, abbreviate only complete generated request formats. */
export function displayTopicTitle(title: string, forwardedTitle?: string): string {
  if (forwardedTitle && /^Forwarded chat \/ 转发聊天(?:记录)?$/u.test(title)) return forwardedTitle;
  const chinese =
    /^运行(?:工作流|常用计划)「([^「」\r\n]+)」(?:[ \t]*\(v[1-9]\d*\))?(?:\s*参数[:：][^\r\n]*)?\s*$/u;
  const english =
    /^Run (?:workflow|saved plan) "([^"\r\n]+)"(?:[ \t]*\(v[1-9]\d*\))?(?:\s*Parameters:[^\r\n]*)?\s*$/u;
  return (chinese.exec(title) ?? english.exec(title))?.[1] ?? title;
}
