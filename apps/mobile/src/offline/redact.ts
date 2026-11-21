import { toBase64 } from "../storage/base64.ts";
/** Known model credentials never enter receipts, tool text, streaming UI or imported history. */
export function offlineRedactor(values: readonly string[]) {
  const variants = values
    .filter((v) => v.length > 0)
    .flatMap((v) => {
      const base64 = toBase64(new TextEncoder().encode(v));
      return [
        v,
        encodeURIComponent(v),
        JSON.stringify(v).slice(1, -1),
        base64,
        base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""),
      ];
    });
  const secrets = [...new Set(variants)].sort((a, b) => b.length - a.length);
  return (value: string) => {
    let result = value;
    for (const secret of secrets) {
      result = result.split(secret).join("[redacted]");
      // A streamed chunk may end in the first half of a credential. Hide it until complete.
      for (
        let index = result.indexOf(secret[0] ?? "", Math.max(0, result.length - secret.length));
        index >= 0;
        index = result.indexOf(secret[0] ?? "", index + 1)
      ) {
        const suffix = result.slice(index);
        if (suffix.length >= Math.min(4, secret.length) && secret.startsWith(suffix)) {
          result = `${result.slice(0, index)}[redacted]`;
          break;
        }
      }
    }
    return result;
  };
}
