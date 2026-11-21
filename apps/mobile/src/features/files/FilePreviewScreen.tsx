import { useLocalSearchParams, useRouter } from "expo-router";
import type { ReactNode } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLinkState, useText } from "../../runtime/context.tsx";
import { radius, type } from "../../theme/scale.ts";
import { useColors } from "../../theme/use-theme.ts";
import { Banner, Button, EmptyState, ErrorLine } from "../../ui/controls.tsx";
import { IconButton, NavBar } from "../../ui/headers.tsx";
import { DOCUMENT_MARKDOWN_LIMIT, DocumentMarkdown } from "../../ui/markdown.tsx";
import { type FileSource, parseFileParams, phoneView } from "./source.ts";
import { useFileActions } from "./use-file-actions.ts";
import { useFilePreview } from "./use-file-preview.ts";
import { useOfficePreview } from "./use-office-preview.ts";
import { ImageView } from "./views/ImageView.tsx";
import { OfficeView } from "./views/OfficeView.tsx";
import { TextLines } from "./views/TextLines.tsx";

export function FilePreviewScreen() {
  const params = parseFileParams(useLocalSearchParams());
  const router = useRouter(),
    t = useText();
  if (!params)
    return (
      <View style={{ flex: 1 }}>
        <NavBar title="" onBack={() => router.back()} />
        <EmptyState icon="file" title={t("stale")} />
      </View>
    );
  return <FilePage source={params.source} name={params.name} />;
}
function baseName(name: string) {
  return name.split(/[\\/]/).pop() || name;
}
function extension(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1, dot + 5).toUpperCase() : "";
}
/** A file that is not shown inline: the type tile, its name and one line of state. */
function FileBlock({ name, children }: { name: string; children?: ReactNode }) {
  const colors = useColors();
  return (
    <View style={{ marginTop: 40, marginHorizontal: 24, alignItems: "center", gap: 10 }}>
      <View
        style={{
          width: 76,
          height: 92,
          borderRadius: radius.row,
          borderWidth: 1,
          borderColor: colors.b2,
          backgroundColor: colors.tert,
          alignItems: "center",
          justifyContent: "flex-end",
          paddingBottom: 14,
        }}
      >
        <Text style={{ fontSize: 13, fontWeight: "700", color: colors.danger }}>
          {extension(name)}
        </Text>
      </View>
      <Text
        style={{
          fontSize: 17,
          lineHeight: 23,
          fontWeight: "600",
          color: colors.text,
          textAlign: "center",
        }}
      >
        {name}
      </Text>
      {children}
    </View>
  );
}
function FilePage({ source, name }: { source: FileSource; name: string }) {
  const router = useRouter(),
    t = useText(),
    colors = useColors(),
    insets = useSafeAreaInsets(),
    mobile = useLinkState();
  const title = baseName(name);
  const { kind, view } = phoneView(title);
  const actions = useFileActions(source, title);
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <NavBar
        title={title}
        subtitle={mobile.status === "online" ? t("fileReadOnly") : t("offline")}
        onBack={() => router.back()}
        right={
          actions.busy ? (
            <View style={{ width: 44, alignItems: "center" }}>
              <ActivityIndicator color={colors.text2} />
            </View>
          ) : (
            <IconButton icon="share" size={20} label={t("fileShare")} onPress={actions.share} />
          )
        }
      />
      <ErrorLine text={actions.error && t(actions.error)} />
      <View style={{ flex: 1 }}>
        {kind === "docx" || kind === "xlsx" || kind === "pptx" ? (
          <OfficeBody source={source} name={title} format={kind} />
        ) : view === "office" || view === "desktop" ? (
          <FileBlock name={title}>
            <Text
              style={[type.caption, { color: colors.text2, textAlign: "center", maxWidth: 260 }]}
            >
              {t("fileNoPhoneView")}
            </Text>
            <Text
              style={[type.caption, { color: colors.text2, textAlign: "center", maxWidth: 260 }]}
            >
              {t("fileNoPhoneViewHint")}
            </Text>
          </FileBlock>
        ) : (
          <FetchedBody source={source} name={title} view={view} />
        )}
      </View>
      {/* Desktop action bar: save as the secondary button, open-with as the primary one. */}
      <View
        style={{
          flexDirection: "row",
          gap: 10,
          paddingTop: 10,
          paddingHorizontal: 16,
          paddingBottom: Math.max(insets.bottom, 8),
          borderTopWidth: 1,
          borderTopColor: colors.b1,
          backgroundColor: colors.bg,
        }}
      >
        <Button
          size="lg"
          icon="save"
          title={t("fileSave")}
          disabled={actions.busy}
          style={{ flex: 1 }}
          onPress={actions.save}
        />
        <Button
          size="lg"
          variant="prim"
          icon="openwith"
          title={t("fileOpenWith")}
          disabled={actions.busy}
          style={{ flex: 1 }}
          onPress={actions.openWith}
        />
      </View>
    </View>
  );
}
function Waiting({ name, progress }: { name: string; progress?: number }) {
  const t = useText(),
    colors = useColors();
  const known = progress !== undefined && progress < 1;
  return (
    <FileBlock name={name}>
      <Text style={[type.caption, { color: colors.text2, textAlign: "center" }]}>
        {known
          ? t("fileLoadingPercent", { percent: Math.round(progress * 100) })
          : t("fileLoading")}
      </Text>
      {known ? (
        <View
          style={{
            width: 200,
            height: 4,
            borderRadius: 2,
            backgroundColor: colors.b2,
            overflow: "hidden",
          }}
        >
          <View
            style={{
              width: `${Math.round(progress * 100)}%`,
              height: 4,
              borderRadius: 2,
              backgroundColor: colors.accent,
            }}
          />
        </View>
      ) : (
        <ActivityIndicator color={colors.text2} />
      )}
    </FileBlock>
  );
}
function Failure({ error, onRetry }: { error: string; onRetry: () => void }) {
  const t = useText();
  return (
    <View style={{ gap: 10, paddingVertical: 30, alignItems: "center" }}>
      <ErrorLine text={error} />
      <Button icon="refresh" title={t("retry")} onPress={onRetry} />
    </View>
  );
}
function FetchedBody({
  source,
  name,
  view,
}: {
  source: FileSource;
  name: string;
  view: "image" | "text" | "markdown";
}) {
  const t = useText(),
    colors = useColors();
  const file = useFilePreview(source, name, view !== "image");
  if (!file.entry)
    return file.error ? (
      <Failure error={t(file.error)} onRetry={file.retry} />
    ) : (
      <Waiting name={name} progress={file.progress} />
    );
  const notes = (file.stale || !!file.error) && (
    <View style={{ paddingHorizontal: 16, paddingTop: 12, gap: 8 }}>
      {file.stale && <Banner text={t("fileCachedCopy")} />}
      <ErrorLine text={file.error && t(file.error)} />
    </View>
  );
  if (view === "image" && file.uri)
    return (
      <View style={{ flex: 1 }}>
        {notes}
        <ImageView uri={file.uri} name={name} />
      </View>
    );
  const text = file.text ?? "";
  if (view === "markdown")
    return (
      <ScrollView
        contentContainerStyle={{
          paddingTop: 16,
          paddingHorizontal: 20,
          paddingBottom: 24,
          gap: 10,
        }}
      >
        {notes}
        <DocumentMarkdown text={text} color={colors.text} />
        {text.length > DOCUMENT_MARKDOWN_LIMIT && <Banner text={t("fileTruncated")} />}
      </ScrollView>
    );
  return (
    <View style={{ flex: 1 }}>
      {notes}
      {text ? <TextLines text={text} /> : <EmptyState icon="file" title={t("fileEmpty")} />}
    </View>
  );
}
function OfficeBody({
  source,
  name,
  format,
}: {
  source: FileSource;
  name: string;
  format: "docx" | "xlsx" | "pptx";
}) {
  const t = useText();
  const office = useOfficePreview(source, format);
  if (!office.first)
    return office.error ? (
      <Failure error={t(office.error)} onRetry={office.retry} />
    ) : (
      <Waiting name={name} />
    );
  return (
    <View style={{ flex: 1 }}>
      <ErrorLine text={office.error && t(office.error)} />
      <OfficeView office={office} />
    </View>
  );
}
