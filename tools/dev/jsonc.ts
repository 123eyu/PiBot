/** Probe-only JSONC reader; preserves comment-looking text inside JSON strings. */
export function parseJsonc(text: string): Record<string, unknown> {
  let output = "";
  let string = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index] as string;
    const next = text[index + 1];
    if (string) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') string = false;
      continue;
    }
    if (char === '"') {
      string = true;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index++;
      output += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index++;
      index++;
      continue;
    }
    output += char;
  }
  let json = "";
  string = false;
  escaped = false;
  for (let index = 0; index < output.length; index++) {
    const char = output[index] as string;
    if (string) {
      json += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') string = false;
      continue;
    }
    if (char === '"') string = true;
    if (char === ",") {
      let next = index + 1;
      while (/\s/.test(output[next] ?? "")) next++;
      if (output[next] === "}" || output[next] === "]") continue;
    }
    json += char;
  }
  return JSON.parse(json) as Record<string, unknown>;
}
