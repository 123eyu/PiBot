import type { OfficeContent } from "@pibot/protocol-base/office-content";
import { OfficePackage } from "../package.ts";
import { validatePackage } from "../validate.ts";
import { addBuiltinMaster, addNotesMaster } from "./masters.ts";
import { addPackageMetadata, assertUniquePresentationIds } from "./package-metadata.ts";
import { ns, PresentationParts, pptType } from "./parts.ts";
import { buildSlides } from "./slides.ts";
import { importPresentationTemplate } from "./template.ts";
import { HEIGHT, themes, WIDTH } from "./themes.ts";

export { readPresentationLayouts } from "./template.ts";
export { layouts, themes } from "./themes.ts";

type Presentation = Extract<OfficeContent, { kind: "pptx" }>;

export async function writePresentation(
  content: Presentation,
  assets: Record<string, Uint8Array>,
  retainedTemplateParts = new Set<string>(),
) {
  let theme = themes[content.theme ?? "classic"];
  const templateBytes = content.template && assets[content.template.path];
  if (content.template && !templateBytes) throw new Error("office_invalid");
  const parts = new PresentationParts(!templateBytes);
  const imported = templateBytes
    ? await importPresentationTemplate(
        templateBytes,
        parts,
        content.template?.master ?? 1,
        retainedTemplateParts,
      )
    : undefined;
  if (imported) theme = imported.theme;
  const builtin = imported ? undefined : addBuiltinMaster(parts, theme);
  const width = imported?.width ?? WIDTH,
    height = imported?.height ?? HEIGHT;
  const presentation = "ppt/presentation.xml";
  const master = imported?.master ?? builtin?.master;
  if (!master) throw new Error("office_invalid");
  const masterId = parts.relate(presentation, "slideMaster", master);
  let notesMaster: string | undefined;
  let notesId: string | undefined;
  if (content.slides.some((slide) => slide.notes !== undefined)) {
    notesMaster = addNotesMaster(parts, theme);
    notesId = parts.relate(presentation, "notesMaster", notesMaster);
  }
  const slideRefs = await buildSlides({
    content,
    assets,
    parts,
    imported,
    builtin,
    theme,
    width,
    height,
    presentation,
    notesMaster,
  });
  const presentationId = imported ? Math.max(imported.maxLayoutId + 1, 2147483648) : 2147483648;
  if (presentationId > 4294967295) throw new Error("office_unsupported");
  parts.part(
    presentation,
    pptType("presentation.main"),
    [
      `<p:presentation ${ns}><p:sldMasterIdLst>`,
      `<p:sldMasterId id="${presentationId}" r:id="${masterId}"/></p:sldMasterIdLst>`,
      notesId
        ? `<p:notesMasterIdLst><p:notesMasterId r:id="${notesId}"/></p:notesMasterIdLst>`
        : "",
      `<p:sldIdLst>${slideRefs.join("")}</p:sldIdLst><p:sldSz cx="${width}" cy="${height}"/>`,
      '<p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle/></p:presentation>',
    ].join(""),
  );
  parts.relate("", "officeDocument", presentation);
  addPackageMetadata(parts, presentation);
  // Validate the assembled graph before it reaches the shared create-only publication path.
  const candidate = parts.write();
  const packageResult = await OfficePackage.open(candidate);
  assertUniquePresentationIds(packageResult, parts.root);
  if (validatePackage(packageResult, "pptx", retainedTemplateParts).serious)
    throw new Error("office_invalid");
  return candidate;
}
