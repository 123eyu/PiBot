import { fileURLToPath } from "node:url";

/** Source owns its resources; the desktop build keeps the existing out/builtin layout. */
export function defaultBuiltinDir(): string {
  return fileURLToPath(
    new URL(import.meta.url.endsWith(".ts") ? "../../../builtin/" : "../builtin/", import.meta.url),
  );
}
