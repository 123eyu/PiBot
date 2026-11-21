export const namespaces = {
  docx: [
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "http://purl.oclc.org/ooxml/wordprocessingml/main",
  ],
  xlsx: [
    "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "http://purl.oclc.org/ooxml/spreadsheetml/main",
  ],
  pptx: [
    "http://schemas.openxmlformats.org/presentationml/2006/main",
    "http://purl.oclc.org/ooxml/presentationml/main",
  ],
  drawingml: [
    "http://schemas.openxmlformats.org/drawingml/2006/main",
    "http://purl.oclc.org/ooxml/drawingml/main",
  ],
} as const;

export function hasNamespace(kind: keyof typeof namespaces, uri: string) {
  return (namespaces[kind] as readonly string[]).includes(uri);
}

// graphicData dispatch identifiers differ from the namespace of their payload.
export const tableUris = [
  "http://schemas.openxmlformats.org/drawingml/2006/table",
  "http://purl.oclc.org/ooxml/drawingml/table",
] as const;
