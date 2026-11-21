import { approvalText } from "@pibot/client-core";
import type { Approval, UserQuestionPauseSchema } from "@pibot/protocol";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { z } from "zod";
import { useLanguage, useSharedText, useText } from "../../../runtime/context.tsx";
import { mono, radius, type } from "../../../theme/scale.ts";
import { useColors } from "../../../theme/use-theme.ts";
import { Button, ListCard } from "../../../ui/controls.tsx";
import { Icon, type IconName } from "../../../ui/icons.tsx";
import { Radio } from "../../../ui/sheet.tsx";
import { approvalIcon, approvalTarget } from "../../approvals/card-facts.ts";

/** Header row of an approval card; red on `dangerBg` when the request is dangerous. */
export function ApprovalHeader({ approval, title }: { approval: Approval; title: string }) {
  const colors = useColors();
  const danger = approval.risk === "danger";
  const fg = danger ? colors.danger : colors.text;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingTop: 12,
        paddingHorizontal: 16,
        paddingBottom: 10,
        backgroundColor: danger ? colors.dangerBg : "transparent",
      }}
    >
      <Icon name={approvalIcon(approval)} color={fg} size={18} />
      <Text style={{ flex: 1, fontSize: 15, lineHeight: 21, fontWeight: "600", color: fg }}>
        {title}
      </Text>
    </View>
  );
}
/** The `tert` monospace block holding a command or path. */
export function CodeBlock({ text }: { text: string }) {
  const colors = useColors();
  return (
    <Text
      selectable
      style={[
        mono(13),
        {
          marginTop: 2,
          marginHorizontal: 16,
          marginBottom: 12,
          paddingVertical: 10,
          paddingHorizontal: 12,
          borderRadius: radius.code,
          backgroundColor: colors.tert,
          overflow: "hidden",
          color: colors.text,
        },
      ]}
    >
      {text}
    </Text>
  );
}
/** A result line under a resolved card (allowed, answered, restored). */
export function ResultLine({ text, ok, icon }: { text: string; ok?: boolean; icon: IconName }) {
  const colors = useColors();
  const color = ok ? colors.ok : colors.text2;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 }}>
      <Icon name={icon} color={color} size={14} strokeWidth={2} />
      <Text style={[type.caption, { color }]}>{text}</Text>
    </View>
  );
}
type Pause = z.infer<typeof UserQuestionPauseSchema>;
/** Choice card (desktop execution card): `b2` border, radius 14, radio rows. */
export function QuestionCard({
  pause,
  answered,
  disabled,
  onAnswer,
}: {
  pause: Pause;
  answered?: string;
  disabled: boolean;
  onAnswer: (optionId: string, label: string) => void;
}) {
  const colors = useColors(),
    t = useText();
  const shared = useSharedText();
  const question = pause.fixedOptions
    ? {
        ...pause.question,
        prompt: shared("group.plan.limit.question"),
        options: pause.question.options.map((option) =>
          option.id === "extend" || option.id === "solo" || option.id === "end"
            ? { ...option, label: shared(`group.plan.limit.${option.id}`) }
            : option,
        ),
      }
    : pause.question;
  const picked = pause.answer?.text ?? answered;
  return (
    <View
      style={{
        alignSelf: "stretch",
        borderWidth: 1,
        borderColor: colors.b2,
        borderRadius: radius.soft,
        backgroundColor: colors.card,
        padding: 14,
        gap: 10,
      }}
    >
      <Text style={[type.bodyStrong, { color: colors.text }]}>{question.prompt}</Text>
      <View>
        {question.options.map((option) => (
          <Pressable
            key={option.id}
            accessibilityRole="button"
            accessibilityState={{
              disabled: !!picked || disabled,
              selected: pause.answer?.optionId
                ? pause.answer.optionId === option.id
                : picked === option.label,
            }}
            disabled={!!picked || disabled}
            onPress={() => onAnswer(option.id, option.label)}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              minHeight: 44,
              paddingVertical: 8,
              paddingHorizontal: 10,
              borderRadius: radius.code,
              backgroundColor: pressed ? colors.hover : "transparent",
              opacity: disabled && !picked ? 0.5 : 1,
            })}
          >
            <Radio
              on={
                pause.answer?.optionId
                  ? pause.answer.optionId === option.id
                  : picked === option.label
              }
            />
            <Text style={[type.body, { flex: 1, color: colors.text }]}>
              {option.label}
              {!pause.fixedOptions && option.id === pause.question.recommendedId && (
                <Text style={[type.caption, { color: colors.text2 }]}> · {t("recommended")}</Text>
              )}
            </Text>
          </Pressable>
        ))}
      </View>
      {!!picked && <ResultLine ok icon="check" text={t("questionAnswered", { answer: picked })} />}
    </View>
  );
}
/** A pending approval of this conversation: the desktop card, `b3` border and shadow. */
export function ApprovalInlineCard({
  approval,
  disabled,
  onView,
  onAllow,
}: {
  approval: Approval;
  disabled: boolean;
  onView: () => void;
  onAllow: () => void;
}) {
  const t = useText(),
    shared = useSharedText(),
    language = useLanguage(),
    colors = useColors();
  const target = approvalTarget(approval, language, shared);
  const danger = approval.risk === "danger";
  return (
    <ListCard flush raised danger={danger}>
      <ApprovalHeader approval={approval} title={approvalText(approval, language).title} />
      {!!target && <CodeBlock text={target} />}
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          justifyContent: "flex-end",
          gap: 8,
          paddingVertical: 10,
          paddingHorizontal: 12,
          borderTopWidth: 1,
          borderTopColor: colors.b1,
        }}
      >
        <Button title={t("view")} onPress={onView} />
        <Button
          variant="prim"
          icon={danger ? "face" : undefined}
          title={t("allowOnce")}
          disabled={disabled}
          onPress={onAllow}
        />
      </View>
    </ListCard>
  );
}
/** Raised chat card with a title row and an accent "View" action (desktop changes card). */
export function ChangesCard({
  title,
  counts,
  onPress,
  children,
}: {
  title: string;
  counts?: ReactNode;
  onPress: () => void;
  children?: ReactNode;
}) {
  const colors = useColors(),
    t = useText();
  return (
    <ListCard flush raised>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingTop: 8,
          paddingRight: 6,
          paddingBottom: 4,
          paddingLeft: 14,
        }}
      >
        <Icon name="file" color={colors.text} size={16} />
        <Text style={{ fontSize: 13.5, fontWeight: "600", color: colors.text }}>{title}</Text>
        {counts}
        <Pressable
          accessibilityRole="button"
          onPress={onPress}
          style={({ pressed }) => ({
            marginLeft: "auto",
            minHeight: 36,
            flexDirection: "row",
            alignItems: "center",
            gap: 2,
            paddingLeft: 10,
            paddingRight: 6,
            borderRadius: 18,
            backgroundColor: pressed ? colors.accentBg : "transparent",
          })}
        >
          <Text style={{ fontSize: 13, color: colors.accent }}>{t("view")}</Text>
          <Icon name="chevronRight" color={colors.accent} size={14} />
        </Pressable>
      </View>
      {children}
    </ListCard>
  );
}
