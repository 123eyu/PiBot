import { memo, type ReactNode, useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import Markdown, {
  type ASTNode,
  MarkdownIt,
  parser as parseMarkdown,
} from "react-native-markdown-display";
import { type Colors, monoFont, useColors } from "../theme/use-theme.ts";
import { useShowLink } from "./link-sheet.tsx";

// Raw HTML and images stay disabled: model output is untrusted. Links never open on the phone
//; tapping one shows its address in a sheet instead.
const parser = MarkdownIt({ html: false, linkify: false }).disable(["image"]);
/**
 * F8 (phone 2026-11-14): on a Chinese-language phone Android draws ‘ and ’ from the CJK font,
 * full-width, so English read "I’ m", "can’ t". Between or after Latin letters they are shown
 * as the ASCII apostrophe; Chinese quotes and code are left as written.
 */
export function latinQuotes(text: string) {
  if (!/[‘’]/.test(text)) return text;
  return text
    .replace(/([A-Za-z0-9])[‘’](?=[A-Za-z]|[\s.,!?;:)\]]|$)/g, "$1'")
    .replace(/(^|[\s([])‘(?=[A-Za-z0-9])/g, "$1'");
}
/**
 * The library gives every node a fresh random key on each parse, so a streaming reply remounted
 * its whole native text tree on every 50 ms flush. Keys from the node's position keep the
 * unchanged head of a reply mounted; only the growing tail updates.
 */
function rekey(nodes: ASTNode[], path: string) {
  nodes.forEach((node, index) => {
    const key = `${path}${index}`;
    node.key = `${key}_${node.type}`;
    if (node.type === "text" && node.content) node.content = latinQuotes(node.content);
    if (node.children?.length) rekey(node.children, `${key}.`);
  });
}
function parse(text: string) {
  // The library's parser hands its AST to the renderer; the identity renderer returns it.
  const ast = parseMarkdown(text, ((nodes: ASTNode[]) => nodes) as never, parser) as ASTNode[];
  rekey(ast, "");
  return ast;
}
/**
 * Parsed replies by message id: a bubble scrolled back into the virtualized thread, or a thread
 * reloaded from the computer with the same text, renders without parsing again.
 */
const parsed = new Map<string, { text: string; ast: ASTNode[] }>();
const PARSED_LIMIT = 300;
function cachedParse(text: string, cacheKey: string | undefined) {
  if (!cacheKey) return parse(text);
  const hit = parsed.get(cacheKey);
  // Map order is the LRU order: a hit or a fresh parse moves to the end.
  parsed.delete(cacheKey);
  if (hit && hit.text === text) {
    parsed.set(cacheKey, hit);
    return hit.ast;
  }
  const ast = parse(text);
  parsed.set(cacheKey, { text, ast });
  if (parsed.size > PARSED_LIMIT) {
    const oldest = parsed.keys().next().value;
    if (oldest !== undefined) parsed.delete(oldest);
  }
  return ast;
}
// Stable stand-ins for the library's defaults, which are new on every render and so rebuilt its
// renderer (with a StyleSheet) on every render of every bubble.
const IMAGE_HANDLERS: string[] = [];
const OVERFLOW_ITEM = <Text key="dotdotdot">...</Text>;
const listContent = { flex: 0, flexGrow: 0, flexShrink: 1, minWidth: 0 } as const;
function markdownStyle(colors: Colors, color: string) {
  const code = {
    color,
    backgroundColor: colors.tert,
    borderColor: colors.b2,
    fontFamily: monoFont,
    fontSize: 13.5,
  };
  // Desktop message typography: inline code on `tert` with radius 4, blocks with radius 10.
  const block = { ...code, fontSize: 13, borderWidth: 0, borderRadius: 10, padding: 12 };
  return {
    body: { color, fontSize: 15, lineHeight: 22 },
    paragraph: { marginTop: 0, marginBottom: 0 },
    heading1: { fontSize: 20, lineHeight: 26, fontWeight: "600" as const, marginBottom: 10 },
    heading2: {
      fontSize: 16,
      lineHeight: 22,
      fontWeight: "600" as const,
      marginTop: 8,
      marginBottom: 6,
    },
    heading3: { fontSize: 15, lineHeight: 22, fontWeight: "600" as const },
    code_inline: { ...code, borderWidth: 0, borderRadius: 4 },
    code_block: block,
    fence: block,
    link: { color: colors.accent, textDecorationLine: "underline" as const },
    hr: { backgroundColor: colors.b2 },
    blockquote: { backgroundColor: colors.tert, borderColor: colors.b3 },
    table: { borderColor: colors.b3, borderRadius: 8 },
    tr: { borderColor: colors.b3 },
    // Columns size to their content within a band: a fixed narrow width turned a paragraph-long
    // cell into a strip thousands of pixels tall (real phone 2026-11-12). The table scrolls
    // sideways, so wide tables stay readable without squeezing.
    blocklink: { borderColor: colors.b2 },
    // F6 (phone 2026-11-14): a reply bubble sizes to its text, and the library's `flex: 1` item
    // text has no width of its own there, so a reply that is only a list drew an empty bubble
    // with a bullet. Item text takes its own width and wraps within the bubble instead.
    bullet_list_content: listContent,
    ordered_list_content: listContent,
  };
}

type AstNode = { type: string; key: string; content?: string; children?: AstNode[] };
/** Plain text of a cell; inline formatting inside phone tables is dropped for a stable layout. */
function cellText(node: AstNode): string {
  if (node.type === "text" || node.type === "code_inline") return node.content ?? "";
  if (node.type === "softbreak" || node.type === "hardbreak") return " ";
  return (node.children ?? []).map(cellText).join("");
}
/** Rough 14 px width without measuring: CJK and full-width glyphs are about twice Latin ones. */
function textWidth(text: string) {
  let width = 0;
  for (const char of text)
    width +=
      /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u.test(
        char,
      )
        ? 14
        : 7.6;
  return width;
}
/**
 * Phone tables (real phone 2026-11-12): one width per column from its longest cell, between 96
 * and 260 px, so columns line up across rows and a long cell wraps instead of becoming a narrow
 * strip thousands of pixels tall. Wide tables scroll sideways.
 */
function PhoneTable({
  node,
  color,
  border,
  headerBg,
}: {
  node: AstNode;
  color: string;
  border: string;
  headerBg: string;
}) {
  const rows: { key: string; cells: string[]; header: boolean }[] = [];
  for (const part of node.children ?? [])
    for (const row of part.children ?? [])
      rows.push({
        key: row.key,
        cells: (row.children ?? []).map(cellText),
        header: part.type === "thead",
      });
  const columns = Math.max(0, ...rows.map((row) => row.cells.length));
  const widths = Array.from({ length: columns }, (_, column) => {
    const longest = Math.max(0, ...rows.map((row) => textWidth(row.cells[column] ?? "")));
    return Math.min(260, Math.max(96, Math.ceil(longest) + 18));
  });
  // An explicit table width: without it the scroll content took the viewport's width, rows
  // overflowed and were clipped by the rounded border, and there was nothing to scroll (F-M1).
  const total = widths.reduce((sum, width) => sum + width, 0) + 2;
  return (
    <ScrollView
      horizontal
      nestedScrollEnabled
      // RN's ScrollView defaults to flexGrow 1 and took the bubble's spare height as a blank band.
      style={{ alignSelf: "stretch", flexGrow: 0, marginVertical: 6 }}
      contentContainerStyle={{ alignItems: "flex-start" }}
    >
      <View
        // The reply bubble is a Pressable; on Android its responder blocks the native horizontal
        // scroll. The table claims its own touches so the ScrollView receives the swipe.
        onStartShouldSetResponder={() => true}
        style={{
          width: total,
          borderWidth: 1,
          borderColor: border,
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        {rows.map((row, r) => (
          <View
            key={row.key}
            style={{
              flexDirection: "row",
              width: total - 2,
              borderTopWidth: r ? 1 : 0,
              borderColor: border,
            }}
          >
            {widths.map((width, c) => (
              <Text
                // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional and never reorder.
                key={c}
                style={{
                  width,
                  flexShrink: 0,
                  padding: 8,
                  color,
                  fontSize: 14,
                  lineHeight: 20,
                  fontWeight: row.header ? "600" : "400",
                  backgroundColor: row.header ? headerBg : undefined,
                  borderLeftWidth: c ? 1 : 0,
                  borderColor: border,
                }}
              >
                {row.cells[c] ?? ""}
              </Text>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}
function Body({
  text,
  color,
  spaced,
  cacheKey,
}: {
  text: string;
  color: string;
  spaced?: boolean;
  cacheKey?: string;
}) {
  const colors = useColors();
  const showLink = useShowLink();
  const style = useMemo(() => {
    const base = markdownStyle(colors, color);
    return spaced ? { ...base, paragraph: { marginTop: 0, marginBottom: 10 } } : base;
  }, [colors, color, spaced]);
  const rules = useMemo(
    () => ({
      // A fixed root key: the library's random one remounted the whole reply on every render.
      body: (_node: ASTNode, children: ReactNode[], _parents: ASTNode[], styles: unknown) => (
        <View key="body" style={(styles as Record<string, object>)._VIEW_SAFE_body}>
          {children}
        </View>
      ),
      table: (node: ASTNode) => (
        <PhoneTable
          key={node.key}
          node={node as AstNode}
          color={color}
          border={colors.b3}
          headerBg={colors.tert}
        />
      ),
    }),
    [color, colors],
  );
  const onLinkPress = useMemo(
    () => (url: string) => {
      showLink(url);
      return false;
    },
    [showLink],
  );
  const ast = useMemo(() => cachedParse(text, cacheKey), [text, cacheKey]);
  // Not in the typings, but read by the library: stable values keep its renderer memoized.
  const stable = { allowedImageHandlers: IMAGE_HANDLERS, topLevelMaxExceededItem: OVERFLOW_ITEM };
  return (
    <Markdown rules={rules} markdownit={parser} onLinkPress={onLinkPress} style={style} {...stable}>
      {/* A parsed AST is accepted as children and skips the library's own parse. */}
      {ast as unknown as ReactNode}
    </Markdown>
  );
}
/**
 * A chat reply: the tail is what matters while it streams. `cacheKey` (the message id) keeps
 * the parsed reply across remounts.
 */
export const MessageMarkdown = memo(function MessageMarkdown({
  text,
  color,
  cacheKey,
}: {
  text: string;
  color: string;
  cacheKey?: string;
}) {
  return <Body text={text.slice(-100_000)} color={color} cacheKey={cacheKey} />;
});
/** A previewed Markdown file: the head, with paragraph spacing; the caller notes truncation. */
export const DOCUMENT_MARKDOWN_LIMIT = 200_000;
export function DocumentMarkdown({ text, color }: { text: string; color: string }) {
  return <Body text={text.slice(0, DOCUMENT_MARKDOWN_LIMIT)} color={color} spaced />;
}
