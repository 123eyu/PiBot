import tokens from "@pibot/ui/tokens.css?raw";

export function windowColors(dark: boolean) {
  const selector = dark ? '[data-theme="dark"] {' : ':root[data-theme="light"] {';
  const block = tokens.slice(tokens.indexOf(selector)).split("}")[0] ?? "";
  const value = (name: string) => {
    const color = new RegExp(`--${name}:\\s*([^;]+);`).exec(block)?.[1];
    if (!color) throw new Error(`Missing window theme token: ${name}`);
    return color.trim();
  };
  return { background: value("bg"), color: value("side"), symbolColor: value("text") };
}
