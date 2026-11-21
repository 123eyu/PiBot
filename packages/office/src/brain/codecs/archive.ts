import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { zipSync } from "fflate";
import { fromBuffer } from "yauzl";

export const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_XML_BYTES = 8 * 1024 * 1024;
export const MODEL_PART = "pibot/content-model.json";
export type XmlNode = {
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  text: string;
};
export type OfficeArchive = Map<string, Uint8Array>;

export async function readArchive(bytes: Uint8Array): Promise<OfficeArchive> {
  if (!bytes.byteLength || bytes.byteLength > MAX_FILE_BYTES) throw new Error("office_file_limit");
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error("office_encrypted_or_invalid");
  return new Promise((resolve, reject) => {
    fromBuffer(
      Buffer.from(bytes),
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, zip) => {
        if (error || !zip) return reject(new Error("office_invalid_archive"));
        const files: OfficeArchive = new Map();
        let total = 0;
        let entries = 0;
        let stopped = false;
        const fail = (reason: string) => {
          if (!stopped) {
            stopped = true;
            zip.close();
            reject(new Error(reason));
          }
        };
        zip.on("error", () => fail("office_invalid_archive"));
        zip.on("end", () => {
          if (!stopped) {
            stopped = true;
            zip.close();
            resolve(files);
          }
        });
        zip.on("entry", (entry) => {
          const name = entry.fileName;
          entries++;
          if (
            entries > 2_000 ||
            name.length > 512 ||
            // fflate's flat ZIP writer uses an ordinary object for root names.
            name === "__proto__" ||
            name.includes("\\") ||
            name.startsWith("/") ||
            name.split("/").includes("..") ||
            files.has(name)
          )
            return fail("office_archive_limit");
          if (entry.generalPurposeBitFlag & 1) return fail("office_encrypted_or_invalid");
          if (name.endsWith("/")) {
            zip.readEntry();
            return;
          }
          total += entry.uncompressedSize;
          if (
            total > MAX_EXPANDED_BYTES ||
            ((name.endsWith(".xml") || name.endsWith(".rels")) &&
              entry.uncompressedSize > MAX_XML_BYTES) ||
            entry.uncompressedSize > Math.max(1_048_576, entry.compressedSize * 500)
          )
            return fail("office_archive_limit");
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) return fail("office_invalid_archive");
            const chunks: Buffer[] = [];
            let size = 0;
            let crc = 0;
            stream.on("error", () => fail("office_invalid_archive"));
            stream.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > entry.uncompressedSize || size > MAX_EXPANDED_BYTES) {
                stream.destroy();
                fail("office_archive_limit");
              } else {
                crc = crc32(chunk, crc);
                chunks.push(chunk);
              }
            });
            stream.on("end", () => {
              if (!stopped) {
                if (size !== entry.uncompressedSize || crc !== entry.crc32)
                  return fail("office_invalid_archive");
                files.set(name, Buffer.concat(chunks));
                zip.readEntry();
              }
            });
          });
        });
        zip.readEntry();
      },
    );
  });
}

export function parseXml(bytes: Uint8Array): XmlNode[] {
  if (bytes.byteLength > MAX_XML_BYTES) throw new Error("office_xml_limit");
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error("office_xml_entities_forbidden");
  let depth = 0;
  let nodes = 0;
  for (const match of source.matchAll(/<[^>]*>/g)) {
    const token = match[0];
    if (token.startsWith("<?") || token.startsWith("<!")) continue;
    if (token.startsWith("</")) depth--;
    else {
      nodes++;
      if (!token.endsWith("/>")) depth++;
    }
    if (depth > 128 || nodes > 200_000) throw new Error("office_xml_limit");
  }
  if (XMLValidator.validate(source) !== true) throw new Error("office_invalid_xml");
  const parsed: unknown = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    trimValues: false,
    parseTagValue: false,
    parseAttributeValue: false,
    processEntities: true,
    // This parser version gates XML numeric references behind htmlEntities as well.
    htmlEntities: true,
  }).parse(source);
  return convert(parsed);
}
function convert(value: unknown): XmlNode[] {
  if (!Array.isArray(value)) return [];
  const output: XmlNode[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    for (const [name, children] of Object.entries(record)) {
      if (name === ":@" || name.startsWith("?")) continue;
      if (name === "#text") {
        output.push({ name, text: String(children), attributes: {}, children: [] });
        continue;
      }
      const attributes: Record<string, string> = {};
      if (record[":@"] && typeof record[":@"] === "object")
        for (const [key, entry] of Object.entries(record[":@"] as Record<string, unknown>))
          attributes[key.replace(/^@_/, "")] = String(entry);
      output.push({ name, attributes, children: convert(children), text: "" });
    }
  }
  return output;
}
export function localName(node: XmlNode): string {
  return node.name.split(":").at(-1) ?? node.name;
}
export function descendants(nodes: XmlNode[], name: string): XmlNode[] {
  const found: XmlNode[] = [];
  const visit = (items: XmlNode[]) => {
    for (const node of items) {
      if (localName(node) === name) found.push(node);
      visit(node.children);
    }
  };
  visit(nodes);
  return found;
}
export function nodeText(node: XmlNode): string {
  return node.name === "#text" ? node.text : node.children.map(nodeText).join("");
}
export function texts(nodes: XmlNode[]): string {
  return descendants(nodes, "t").map(nodeText).join("");
}
export function requiredXml(files: OfficeArchive, name: string): XmlNode[] {
  const bytes = files.get(name);
  if (!bytes) throw new Error("office_invalid_document");
  return parseXml(bytes);
}
export function archiveDigest(files: OfficeArchive): string {
  const hash = createHash("sha256");
  for (const name of [...files.keys()].filter((key) => key !== MODEL_PART).sort()) {
    hash.update(name);
    hash.update("\0");
    hash.update(files.get(name) ?? new Uint8Array());
    hash.update("\0");
  }
  return hash.digest("hex");
}
export function packArchive(files: OfficeArchive): Uint8Array {
  if (files.has("__proto__")) throw new Error("office_invalid_archive");
  const result = zipSync(Object.fromEntries(files), { level: 6 });
  if (result.byteLength > MAX_FILE_BYTES) throw new Error("office_file_limit");
  return result;
}
