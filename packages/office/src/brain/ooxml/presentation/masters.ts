import { shape } from "./objects.ts";
import {
  bg,
  colorMap,
  colorOverride,
  drawingTheme,
  ns,
  type PresentationParts,
  pptType,
  shapeTree,
  themeType,
} from "./parts.ts";
import { textShape } from "./text.ts";
import {
  HEIGHT,
  layoutDefinitions,
  layouts,
  rect,
  slideGrid,
  type Theme,
  WIDTH,
} from "./themes.ts";

const NOTES_WIDTH = 6_858_000;
const NOTES_HEIGHT = 9_144_000;

export function addBuiltinMaster(parts: PresentationParts, theme: Theme) {
  const master = `${parts.root}/slideMasters/master.xml`;
  const paths = layouts.map((_layout, i) => `${parts.root}/slideLayouts/layout${i + 1}.xml`);
  parts.part(`${parts.root}/theme/theme1.xml`, themeType, drawingTheme(theme));
  const ids = paths
    .map(
      (path, i) =>
        `<p:sldLayoutId id="${2147483649 + i}" r:id="${parts.relate(master, "slideLayout", path)}"/>`,
    )
    .join("");
  parts.relate(master, "theme", `${parts.root}/theme/theme1.xml`);
  const style = (size: number) =>
    `<a:lvl1pPr><a:defRPr sz="${size}">${'<a:solidFill><a:schemeClr val="tx1"/></a:solidFill>'}<a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/></a:defRPr></a:lvl1pPr>`;
  parts.part(
    master,
    pptType("slideMaster"),
    [
      `<p:sldMaster ${ns}><p:cSld name="${theme.name}">${bg(theme.background)}${shapeTree("")}</p:cSld>`,
      `${colorMap}<p:sldLayoutIdLst>${ids}</p:sldLayoutIdLst><p:txStyles>`,
      `<p:titleStyle>${style(3000)}</p:titleStyle><p:bodyStyle>${style(1900)}</p:bodyStyle>`,
      `<p:otherStyle>${style(1800)}</p:otherStyle></p:txStyles></p:sldMaster>`,
    ].join(""),
  );
  layouts.forEach((layout, index) => {
    const path = paths[index];
    if (!path) throw new Error("office_invalid");
    const grid = slideGrid(theme, layout);
    const ink = grid.section ? theme.onSection : theme.ink;
    let id = 2;
    let content = "";
    if (theme.decoration === "rail" && layout !== "full-image")
      content += shape(
        id++,
        "rect",
        rect(0, 0, 0.012, 1),
        grid.section ? theme.colors[1] : theme.colors[0],
        WIDTH,
        HEIGHT,
      );
    if (theme.decoration === "band" && layout !== "full-image")
      content += shape(id++, "rect", rect(0, 0.97, 1, 0.03), theme.colors[0], WIDTH, HEIGHT);
    if (theme.decoration === "rule" && !grid.section)
      content += shape(
        id++,
        "line",
        rect(theme.margin, 0.235, 1 - theme.margin * 2, 0.001),
        theme.colors[0],
        WIDTH,
        HEIGHT,
      );
    const add = (
      box: typeof grid.title,
      type: string,
      index: string,
      size: number,
      heading = false,
    ) => {
      if (box)
        content += textShape(id++, "", box, theme, WIDTH, HEIGHT, {
          size,
          color: ink,
          heading,
          bold: heading,
          centered: grid.centered,
          placeholder: { type, index },
        });
    };
    add(grid.title, layout === "cover" ? "ctrTitle" : "title", "0", grid.titleSize, true);
    add(grid.text, "body", "1", grid.bodySize);
    add(grid.subtitle, "subTitle", "2", 18);
    add(grid.secondary, "body", "3", grid.bodySize);
    if (["chart", "table", "image-text", "full-image"].includes(layout))
      add(grid.object, layout === "chart" ? "chart" : layout === "table" ? "tbl" : "pic", "4", 18);
    parts.part(
      path,
      pptType("slideLayout"),
      `<p:sldLayout ${ns} type="${layoutDefinitions[layout][1]}" preserve="1"><p:cSld name="${layoutDefinitions[layout][0]}">${bg(grid.section ? theme.section : theme.background)}${shapeTree(content)}</p:cSld>${colorOverride}</p:sldLayout>`,
    );
    parts.relate(path, "slideMaster", master);
  });
  return { master, paths };
}

export function addNotesMaster(parts: PresentationParts, theme: Theme) {
  const master = `${parts.root}/notesMasters/notesMaster1.xml`;
  const themePath = `${parts.root}/theme/themeNotes.xml`;
  parts.part(themePath, themeType, drawingTheme(theme));
  parts.part(
    master,
    pptType("notesMaster"),
    `<p:notesMaster ${ns}><p:cSld>${shapeTree(notesPlaceholders(theme))}</p:cSld>${colorMap}<p:notesStyle><a:lvl1pPr><a:defRPr sz="1200"/></a:lvl1pPr></p:notesStyle></p:notesMaster>`,
  );
  parts.relate(master, "theme", themePath);
  return master;
}

function notesPlaceholders(theme: Theme) {
  return (
    textShape(2, "", rect(0.1, 0.3, 0.8, 0.6), theme, NOTES_WIDTH, NOTES_HEIGHT, {
      size: 12,
      color: theme.ink,
      placeholder: { type: "body", index: "1" },
    }) +
    textShape(3, "", rect(0.1, 0.05, 0.8, 0.2), theme, NOTES_WIDTH, NOTES_HEIGHT, {
      size: 10,
      color: theme.muted,
      placeholder: { type: "sldImg" },
    })
  );
}
