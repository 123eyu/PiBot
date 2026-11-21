import type { OfficeContent, PresentationLayoutId } from "@pibot/protocol-base/office-content";
import type { addBuiltinMaster } from "./masters.ts";
import { nativeObject } from "./objects.ts";
import { bg, colorOverride, ns, type PresentationParts, pptType, shapeTree } from "./parts.ts";
import type { importPresentationTemplate, Placeholder } from "./template.ts";
import { textShape } from "./text.ts";
import { type Box, layouts, readableOn, rect, slideGrid, type themes } from "./themes.ts";

type Presentation = Extract<OfficeContent, { kind: "pptx" }>;
export async function buildSlides(args: {
  content: Presentation;
  assets: Record<string, Uint8Array>;
  parts: PresentationParts;
  imported: Awaited<ReturnType<typeof importPresentationTemplate>> | undefined;
  builtin: ReturnType<typeof addBuiltinMaster> | undefined;
  theme: (typeof themes)[keyof typeof themes];
  width: number;
  height: number;
  presentation: string;
  notesMaster: string | undefined;
}) {
  let objectOrdinal = 0;
  const slideRefs: string[] = [];
  for (const [index, slide] of args.content.slides.entries()) {
    const part = `${args.parts.root}/slides/slide${index + 1}.xml`;
    const layout = slide.layout ?? "title-body";
    const selected = args.imported?.layouts[(slide.templateLayout ?? 1) - 1];
    if (args.imported && !selected) throw new Error("office_invalid");
    const path = selected?.path ?? args.builtin?.paths[layouts.indexOf(layout)];
    if (!path) throw new Error("office_invalid");
    args.parts.relate(part, "slideLayout", path);
    const grid = slideGrid(args.theme, layout);
    const ink = grid.section ? args.theme.onSection : args.theme.ink;
    const { shapes, nextId, placeholder } = buildSlideText(
      slide,
      layout,
      grid,
      args.theme,
      args.width,
      args.height,
      args.imported,
      selected?.placeholders ?? builtinPlaceholders(layout),
      ink,
    );
    const { objects, lastId } = await placeObjects(slide, layout, grid, nextId, {
      ...args,
      part,
      objectOrdinal,
      placeholder,
    });
    objectOrdinal = lastId.ordinal;
    const contentXml = layout === "full-image" ? [...objects, ...shapes] : [...shapes, ...objects];
    if (!args.imported && layout !== "full-image")
      contentXml.push(
        textShape(
          lastId.next(),
          String(index + 1),
          rect(0.9, 0.94, 0.04, 0.03),
          args.theme,
          args.width,
          args.height,
          {
            size: 10,
            color: readableOn(
              grid.section ? args.theme.onSection : args.theme.muted,
              grid.section ? args.theme.section : args.theme.background,
            ),
          },
        ),
      );
    args.parts.part(part, pptType("slide"), slideXml(args.theme, grid, args.imported, contentXml));
    slideRefs.push(
      `<p:sldId id="${256 + index}" r:id="${args.parts.relate(args.presentation, "slide", part)}"/>`,
    );
    if (slide.notes !== undefined && args.notesMaster)
      writeNotes(args.parts, args.theme, part, args.notesMaster, index, slide.notes);
  }
  return slideRefs;
}

function buildSlideText(
  slide: Presentation["slides"][number],
  layout: PresentationLayoutId,
  grid: ReturnType<typeof slideGrid>,
  theme: (typeof themes)[keyof typeof themes],
  width: number,
  height: number,
  imported: Awaited<ReturnType<typeof importPresentationTemplate>> | undefined,
  pool: Placeholder[],
  ink: string,
) {
  let id = 2;
  const shapes: string[] = [];
  const used = new Set<Placeholder>();
  const placeholder = (types: string[]) => {
    const ph = types.flatMap(
      (type) => pool.find((candidate) => !used.has(candidate) && candidate.type === type) ?? [],
    )[0];
    if (ph) used.add(ph);
    return ph;
  };
  const addText = (
    value: string | undefined,
    box: typeof grid.title,
    types: string[],
    size: number,
    heading = false,
  ) => {
    if (value === undefined) return;
    if (!box) throw new Error("office_unsupported");
    const ph = placeholder(types);
    if (imported && !ph) throw new Error("office_unsupported");
    shapes.push(
      textShape(id++, value, box, theme, width, height, {
        size,
        color: ink,
        heading,
        bold: heading,
        centered: grid.centered,
        inherit: !!imported,
        placeholder: ph,
        background: !imported && layout === "full-image" ? theme.section : undefined,
      }),
    );
  };
  addText(slide.title, grid.title, ["title", "ctrTitle"], grid.titleSize, true);
  addText(slide.text, grid.text, ["body", "obj"], grid.bodySize);
  addText(slide.subtitle, grid.subtitle, ["subTitle", "body", "obj"], 18);
  if (slide.secondaryText !== undefined && !imported && layout !== "two-column")
    throw new Error("office_unsupported");
  addText(
    slide.secondaryText,
    grid.secondary ?? (imported ? grid.text : undefined),
    ["body", "obj"],
    grid.bodySize,
  );
  return { shapes, nextId: id, placeholder };
}

async function placeObjects(
  slide: Presentation["slides"][number],
  layout: PresentationLayoutId,
  grid: ReturnType<typeof slideGrid>,
  nextId: number,
  args: Parameters<typeof buildSlides>[0] & {
    part: string;
    objectOrdinal: number;
    placeholder: (types: string[]) => Placeholder | undefined;
  },
) {
  const objects: string[] = [];
  const autoCount = slide.objects?.filter(({ box }) => box === undefined).length ?? 0;
  let automatic = 0;
  let currentId = nextId;
  const allocator = { next: () => currentId++ };
  const placeholder = args.placeholder;
  for (const object of slide.objects ?? []) {
    const ph =
      object.box || (!args.imported && autoCount > 1)
        ? undefined
        : placeholder(
            object.type === "image"
              ? ["pic", "obj"]
              : object.type === "chart"
                ? ["chart", "obj"]
                : object.type === "table"
                  ? ["tbl", "obj"]
                  : [],
          );
    if (args.imported && !object.box && !ph?.box) throw new Error("office_unsupported");
    const box = object.box ?? ph?.box ?? autoBox(grid.object, automatic, autoCount, args.theme.gap);
    if (!object.box) automatic++;
    const input =
      object.type === "image" && layout === "full-image" && object.fit === undefined
        ? { ...object, fit: "cover" as const }
        : object;
    objects.push(
      await nativeObject(input, {
        parts: args.parts,
        slide: args.part,
        ids: allocator,
        width: args.width,
        height: args.height,
        theme: args.theme,
        box,
        placeholder: ph,
        images: args.assets,
        ordinal: ++args.objectOrdinal,
      }),
    );
  }
  return { objects, lastId: { next: allocator.next, ordinal: args.objectOrdinal } };
}

function slideXml(
  theme: (typeof themes)[keyof typeof themes],
  grid: ReturnType<typeof slideGrid>,
  imported: Awaited<ReturnType<typeof importPresentationTemplate>> | undefined,
  content: string[],
) {
  const background = !imported && grid.section ? bg(theme.section) : "";
  return `<p:sld ${ns}><p:cSld>${background}${shapeTree(content.join(""))}</p:cSld>${colorOverride}</p:sld>`;
}

function writeNotes(
  parts: PresentationParts,
  theme: (typeof themes)[keyof typeof themes],
  slide: string,
  notesMaster: string,
  index: number,
  value: string,
) {
  const note = `${parts.root}/notesSlides/notesSlide${index + 1}.xml`;
  const body = textShape(2, value, rect(0.1, 0.3, 0.8, 0.6), theme, 6_858_000, 9_144_000, {
    size: 12,
    color: theme.ink,
    placeholder: { type: "body", index: "1" },
  });
  const image = textShape(3, "", rect(0.1, 0.05, 0.8, 0.2), theme, 6_858_000, 9_144_000, {
    size: 10,
    color: theme.muted,
    placeholder: { type: "sldImg" },
  });
  parts.part(
    note,
    pptType("notesSlide"),
    `<p:notes ${ns}><p:cSld>${shapeTree(body + image)}</p:cSld>${colorOverride}</p:notes>`,
  );
  parts.relate(slide, "notesSlide", note);
  parts.relate(note, "slide", slide);
  parts.relate(note, "notesMaster", notesMaster);
}

function builtinPlaceholders(layout: PresentationLayoutId): Placeholder[] {
  return [
    { type: layout === "cover" ? "ctrTitle" : "title", index: "0" },
    { type: "body", index: "1" },
    { type: "subTitle", index: "2" },
    { type: "body", index: "3" },
    ...(["chart", "table", "image-text", "full-image"].includes(layout)
      ? [{ type: layout === "chart" ? "chart" : layout === "table" ? "tbl" : "pic", index: "4" }]
      : []),
  ];
}

function autoBox(area: Box, index: number, count: number, gap: number): Box {
  if (count <= 1) return area;
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const width = area.width / columns,
    height = area.height / rows;
  const inset = Math.min(gap / 2, width / 5, height / 5);
  return rect(
    area.x + (index % columns) * width + inset,
    area.y + Math.floor(index / columns) * height + inset,
    width - 2 * inset,
    height - 2 * inset,
  );
}
