import { useRouter } from "expo-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { MobileKey } from "../../i18n/messages.ts";
import { useText } from "../../runtime/context.tsx";
import { useColors } from "../../theme/use-theme.ts";
import {
  Banner,
  Button,
  ErrorLine,
  Field,
  FootNote,
  ListCard,
  SectionTitle,
  Separator,
} from "../../ui/controls.tsx";
import { NavBar } from "../../ui/headers.tsx";
import { Icon } from "../../ui/icons.tsx";
import { OptionRow } from "../../ui/sheet.tsx";
import { useTimeText } from "../../ui/time.ts";

interface PageState {
  online: boolean;
  cached: boolean;
  cachedAt?: string;
  connectionState?: MobileKey;
  load?(): unknown;
  conflict: boolean;
  error?: MobileKey;
  data?: unknown;
}
/** A pushed settings page: bar, offline / conflict / error lines, then grouped content. */
export function SettingsPage({
  title,
  state,
  children,
  footer,
  left,
  right,
  tint,
}: {
  title: string;
  state: PageState;
  children: ReactNode;
  footer?: string;
  /** Navigation bar overrides, e.g. Cancel / Create text actions on a creation page. */
  left?: ReactNode;
  right?: ReactNode;
  /** Page colour; Bot pages inherit the Bot's from `PageTint`. */
  tint?: string;
}) {
  const colors = useColors(),
    t = useText(),
    router = useRouter(),
    insets = useSafeAreaInsets(),
    time = useTimeText();
  // A copy read ahead of time says how old it is, so it is never mistaken for live values.
  const withAge = (text: string) =>
    state.cached && state.data !== undefined && state.cachedAt
      ? `${text} · ${t("updatedAgo", { time: time.ago(state.cachedAt) })}`
      : text;
  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.bg }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <NavBar title={title} tint={tint} onBack={() => router.back()} left={left} right={right} />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 24 + insets.bottom }}
      >
        <View style={{ paddingHorizontal: 16, paddingTop: 10, gap: 8 }}>
          {state.connectionState ? (
            <Banner text={withAge(t(state.connectionState))} />
          ) : (
            state.cached && (
              <Banner
                text={state.data ? withAge(t("settingsCached")) : t("settingsEmptyOffline")}
              />
            )
          )}
          {state.conflict && <Banner tone="warn" icon="warning" text={t("settingsConflict")} />}
        </View>
        <ErrorLine text={state.error && t(state.error)} />
        {state.error && state.online && state.load && (
          <Button title={t("settingsRetry")} onPress={() => void state.load?.()} />
        )}
        {children}
        {!!footer && <FootNote text={footer} />}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
export function Note({ text }: { text: string }) {
  const colors = useColors();
  return (
    <Text
      style={{
        fontSize: 12.5,
        lineHeight: 18,
        color: colors.text2,
        paddingHorizontal: 16,
        paddingTop: 10,
        paddingBottom: 10,
      }}
    >
      {text}
    </Text>
  );
}
export function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <>
      {title ? <SectionTitle title={title} /> : <View style={{ height: 16 }} />}
      <ListCard>{children}</ListCard>
    </>
  );
}
/** Rows separated by hairlines; falsy children are skipped. */
export function Rows({ children }: { children: ReactNode[] }) {
  const rows = children.filter(Boolean);
  return (
    <>
      {rows.map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are a fixed, ordered list per render.
        <View key={index}>
          {index > 0 && <Separator />}
          {row}
        </View>
      ))}
    </>
  );
}
export function LinkRow({
  title,
  subtitle,
  value,
  lead,
  onPress,
  disabled,
}: {
  title: string;
  subtitle?: string;
  value?: string;
  lead?: ReactNode;
  onPress: () => void;
  disabled?: boolean;
}) {
  const colors = useColors();
  return (
    <OptionRow
      strong
      title={title}
      subtitle={subtitle}
      value={value}
      lead={lead}
      disabled={disabled}
      right={<Icon name="chevronRight" color={colors.text2} size={16} />}
      onPress={onPress}
    />
  );
}
/**
 * A text field that saves when editing ends. It follows the computer's value until the user
 * starts typing, so a change made on the computer shows up without overwriting a draft.
 */
export function TextField({
  label,
  value,
  placeholder,
  multiline,
  maxLength,
  editable,
  onSave,
}: {
  label: string;
  value: string;
  placeholder?: string;
  multiline?: boolean;
  maxLength: number;
  editable: boolean;
  onSave?: (next: string) => Promise<unknown> | undefined;
}) {
  const colors = useColors();
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);
  const done = async () => {
    editing.current = false;
    if (draft !== value && onSave && (await onSave(draft)) === undefined) setDraft(value);
  };
  return (
    <View style={{ minHeight: 56, paddingVertical: 10, paddingHorizontal: 16, gap: 2 }}>
      <Text style={{ fontSize: 12.5, lineHeight: 18, color: colors.text2 }}>{label}</Text>
      <TextInput
        value={draft}
        editable={editable}
        multiline={multiline}
        maxLength={maxLength}
        placeholder={placeholder}
        placeholderTextColor={colors.text2}
        accessibilityLabel={label}
        onFocus={() => {
          editing.current = true;
        }}
        onChangeText={setDraft}
        onEndEditing={() => void done()}
        style={{
          color: editable ? colors.text : colors.text2,
          fontSize: 15,
          lineHeight: 22,
          paddingVertical: 2,
          minHeight: multiline ? 66 : undefined,
          textAlignVertical: multiline ? "top" : "center",
        }}
      />
    </View>
  );
}
/** A multi-line draft that is saved with an explicit button (persona and norms). */
export function DraftArea({
  label,
  value,
  placeholder,
  maxLength,
  editable,
  onChange,
  minHeight = 180,
}: {
  label: string;
  value: string;
  placeholder: string;
  maxLength: number;
  editable: boolean;
  onChange: (next: string) => void;
  minHeight?: number;
}) {
  const colors = useColors();
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontSize: 13, fontWeight: "600", color: colors.text }}>{label}</Text>
      <Field
        value={value}
        editable={editable}
        multiline
        maxLength={maxLength}
        placeholder={placeholder}
        accessibilityLabel={label}
        onChangeText={onChange}
        style={{ minHeight }}
      />
    </View>
  );
}
