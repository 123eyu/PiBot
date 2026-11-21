import type { OfficeCell, OfficePreview } from "@pibot/protocol";
import { ScrollView, Text, View } from "react-native";
import { useText } from "../../../runtime/context.tsx";
import { useColors } from "../../../theme/use-theme.ts";
import { Banner, Button, Chip, ListCard } from "../../../ui/controls.tsx";
import { pageItems, type useOfficePreview } from "../use-office-preview.ts";

function cellText(cell: OfficeCell) {
  if (cell === null) return "";
  if (typeof cell === "object") return String(cell.cachedValue ?? `=${cell.formula}`);
  return String(cell);
}
function Grid({ rows }: { rows: string[][] }) {
  const colors = useColors();
  return (
    <ScrollView horizontal>
      <View style={{ borderWidth: 1, borderColor: colors.b3, borderRadius: 8, overflow: "hidden" }}>
        {rows.map((row, r) => (
          <View
            // biome-ignore lint/suspicious/noArrayIndexKey: table rows have no identity of their own.
            key={r}
            style={{
              flexDirection: "row",
              borderTopWidth: r ? 1 : 0,
              borderTopColor: colors.b1,
              backgroundColor: r ? undefined : colors.tert,
            }}
          >
            {row.map((cell, c) => (
              <Text
                // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional.
                key={c}
                numberOfLines={4}
                style={{
                  width: 120,
                  padding: 6,
                  fontSize: 12.5,
                  color: colors.text,
                  borderLeftWidth: c ? 1 : 0,
                  borderLeftColor: colors.b1,
                }}
              >
                {cell}
              </Text>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}
function Page({ page, index, start }: { page: OfficePreview; index: number; start: number }) {
  const colors = useColors(),
    t = useText();
  const content = page.content;
  if (content.kind === "docx")
    return (
      <>
        {index === 0 && !!content.title && (
          <Text style={{ fontSize: 20, fontWeight: "600", color: colors.text }}>
            {content.title}
          </Text>
        )}
        {content.blocks.map((block, i) =>
          block.type === "table" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional within a page.
            <Grid key={i} rows={block.rows} />
          ) : (
            <Text
              // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional within a page.
              key={i}
              selectable
              style={
                block.type === "heading"
                  ? {
                      fontSize: Math.max(15, 22 - block.level * 2),
                      fontWeight: "600",
                      color: colors.text,
                    }
                  : { fontSize: 15, lineHeight: 23, color: colors.text }
              }
            >
              {block.text}
            </Text>
          ),
        )}
      </>
    );
  if (content.kind === "xlsx")
    return <Grid rows={(content.sheets[0]?.rows ?? []).map((row) => row.map(cellText))} />;
  return (
    <>
      {content.slides.map((slide, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: slides are positional.
        <ListCard key={i} flush>
          <View style={{ padding: 12, gap: 6 }}>
            <Text style={{ fontSize: 12, color: colors.text2 }}>
              {t("fileSlide", { n: start + i + 1 })}
            </Text>
            {!!slide.title && (
              <Text style={{ fontSize: 16, fontWeight: "600", color: colors.text }}>
                {slide.title}
              </Text>
            )}
            {!!slide.text && (
              <Text selectable style={{ fontSize: 14, lineHeight: 21, color: colors.text }}>
                {slide.text}
              </Text>
            )}
          </View>
        </ListCard>
      ))}
    </>
  );
}
/** The computer's structured content view of a Word, Excel or PowerPoint file (read-only). */
export function OfficeView({ office }: { office: ReturnType<typeof useOfficePreview> }) {
  const colors = useColors(),
    t = useText();
  const first = office.first;
  // office.preview does not echo the offset; pages arrive in order, so slide numbers add up.
  const starts = office.pages.map((_, index) =>
    office.pages.slice(0, index).reduce((sum, page) => sum + pageItems(page), 0),
  );
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      {office.stale && <Banner text={t("fileCachedCopy")} />}
      {!!first?.sheetNames?.length && first.sheetNames.length > 1 && (
        <ScrollView horizontal contentContainerStyle={{ gap: 6 }}>
          {first.sheetNames.map((name, index) => (
            <Chip
              key={name}
              label={name}
              live={index === office.sheet}
              onPress={() => office.selectSheet(index)}
            />
          ))}
        </ScrollView>
      )}
      {office.pages.map((page, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: pages are appended in order and never move.
        <Page key={index} page={page} index={index} start={starts[index] ?? 0} />
      ))}
      {office.pages.some((page) => page.truncated) && <Banner text={t("fileTruncated")} />}
      {office.hasMore && (
        <Button
          title={t("fileMore")}
          disabled={office.busy}
          onPress={office.more}
          style={{ alignSelf: "center" }}
        />
      )}
      {!!first && (
        <Text style={{ alignSelf: "center", fontSize: 12, color: colors.text2 }}>
          {t("fileDesktopFull")}
        </Text>
      )}
    </ScrollView>
  );
}
