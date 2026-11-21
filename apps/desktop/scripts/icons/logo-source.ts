import { readFileSync } from "node:fs";

export function readLogoSource() {
  const logo = readFileSync(
    new URL("../../../../design/canvas/Logo.dc.html", import.meta.url),
    "utf8",
  );
  const paths = [...logo.matchAll(/<path d="(M[^"{}]+)"/g)].map((match) => match[1] ?? "");
  const violet = /violet: \{ fill: '(#[\da-f]{6})', ink: '(#[\da-f]{6})' \}/i.exec(logo);
  const geometry = (name: string) => {
    const value = new RegExp(`var ${name} = '([^']+)'`).exec(logo)?.[1];
    if (!value) throw new Error(`Missing Logo geometry: ${name}`);
    return value;
  };
  const width = (name: string) => {
    const value = new RegExp(`var ${name} = ([\\d.]+);`).exec(logo)?.[1];
    if (!value || !Number.isFinite(Number(value))) throw new Error(`Missing Logo width: ${name}`);
    return Number(value);
  };
  const fill = violet?.[1];
  const ink = violet?.[2];
  if (paths.length !== 2 || paths.some((path) => !path) || !fill || !ink)
    throw new Error("Logo face changed; review generator");
  return {
    paths,
    fill,
    ink,
    square: geometry("SQUARE"),
    blob: geometry("BLOB"),
    circle: geometry("CIRCLE"),
    bodyWidth: width("BODY_W"),
    faceWidth: width("FACE_W"),
    smallFaceWidth: width("SMALL_FACE_W"),
    smallSize: width("SMALL_SIZE"),
  };
}

export function faceSvg(paths: string[], ink: string, width: number): string {
  return `<g fill="none" stroke="${ink}" stroke-width="${width}" stroke-linecap="round">${paths.map((path) => `<path d="${path}"/>`).join("")}</g>`;
}
