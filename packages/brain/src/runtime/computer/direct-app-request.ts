const APP_TITLE = /^(?:通讯录|日历|contacts|calendar|outlook|people)(?:\s*(?:app|应用))?$/iu;
const QUOTES: Record<string, string> = {
  '"': '"',
  "'": "'",
  "「": "」",
  "『": "』",
  "“": "”",
  "‘": "’",
  "`": "`",
};

/** Preserve surrounding intent; line breaks inside examples never create new user commands. */
export function directAppRequest(value: string): string {
  const text = value.slice(0, 80_000);
  // Conservative across the whole request: a later example must not escape an earlier veto.
  if (/不要|别|禁止|不能|不应|不许|勿|无需执行|不必执行|\b(?:do\s+not|don't|never)\b/iu.test(text))
    return "";
  if (
    /(?:以下|下面|如下)(?:的)?(?:示例|代码|引用|文本|命令)|(?:解释|翻译|引用).{0,20}(?:示例|代码|命令)|\b(?:explain|translate|quote)\b|<\/?(?:blockquote|pre|code)\b/iu.test(
      text,
    )
  )
    return "";
  let fence: { char: string; length: number } | undefined;
  const lines: string[] = [];
  let blockquote = false;
  for (const line of text.split(/\r?\n/u)) {
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = { char: marker[0] ?? "", length: marker.length };
      else if (marker[0] === fence.char && marker.length >= fence.length) fence = undefined;
      lines.push("");
    } else {
      if (!line.trim()) blockquote = false;
      if (/^\s*(?:(?:[-*+]|\d+[.)])\s+)?>/u.test(line)) blockquote = true;
      lines.push(fence || blockquote || /^(?: {4}|\t)/u.test(line) ? "" : line);
    }
  }
  const source = lines.join("\n");
  const output: string[] = [];
  for (let index = 0; index < source.length; index++) {
    const char = source[index] ?? "";
    let close = QUOTES[char];
    if (!close) {
      output.push(char);
      continue;
    }
    let start = index + 1;
    if (char === "`") {
      while (source[start] === "`") start++;
      close = "`".repeat(start - index);
    }
    let end = start;
    for (; end < source.length; end++) {
      if (source[end] === "\\") {
        end++;
        continue;
      }
      if (source.startsWith(close, end)) break;
    }
    if (end === source.length) break; // Unclosed references cannot contain direct requests.
    const body = source.slice(start, end);
    // Quoting only an app's title is common in an otherwise direct command.
    output.push(!/[\r\n]/u.test(body) && APP_TITLE.test(body) ? body : " ");
    index = end + close.length - 1;
  }
  return output.join("");
}
