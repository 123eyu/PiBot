import { useRouter } from "expo-router";
import type { ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import type { MobileKey } from "../../i18n/messages.ts";
import { useText } from "../../runtime/context.tsx";
import { useColors } from "../../theme/use-theme.ts";
import {
  EmptyState,
  ErrorLine,
  ListCard,
  SectionTitle,
  Separator,
  Switch,
} from "../../ui/controls.tsx";
import { NavBar } from "../../ui/headers.tsx";
import { useTimeText } from "../../ui/time.ts";
import { AndroidCapabilityRows } from "./AndroidCapabilityRows.tsx";
import type { PhoneDataLogEntry } from "./prefs.ts";
import { usePhoneData } from "./use-phone-data.ts";

function Row({ title, hint, right }: { title: string; hint?: string; right?: ReactNode }) {
  const colors = useColors();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 14 }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ fontSize: 15, color: colors.text }}>{title}</Text>
        {!!hint && (
          <Text style={{ fontSize: 12.5, color: colors.text2, marginTop: 2 }}>{hint}</Text>
        )}
      </View>
      {right}
    </View>
  );
}
const logLabel: Record<PhoneDataLogEntry["category"], MobileKey> = {
  media: "phoneDataLogMedia",
  media_get: "phoneDataLogMediaGet",
  sms_code: "phoneDataLogSms",
  calls: "phoneDataLogCalls",
  notifications: "phoneDataLogNotifications",
};

/** Per computer, what its Bots may read from this phone, and what they did read. */
export function PhoneDataScreen() {
  const colors = useColors(),
    t = useText(),
    router = useRouter(),
    time = useTimeText(),
    data = usePhoneData();
  const android = data.platform === "android";
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <NavBar title={t("phoneDataTitle")} onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
        {!data.computer ? (
          <EmptyState icon="laptop" title={t("phoneDataNoComputer")} />
        ) : (
          <>
            <Text style={{ color: colors.text2, fontSize: 13, padding: 18, paddingBottom: 6 }}>
              {t("phoneDataLead", { name: data.computer.name })}
            </Text>
            <ErrorLine text={data.error && t(data.error)} />
            <ListCard>
              <Row
                title={t("phoneDataMedia")}
                hint={
                  data.prefs.media && data.media === "denied"
                    ? t("phoneDataDenied")
                    : data.prefs.media && data.media === "limited"
                      ? t("phoneDataLimited")
                      : t("phoneDataMediaHint")
                }
                right={
                  <Switch
                    label={t("phoneDataMedia")}
                    value={data.prefs.media}
                    disabled={data.busy}
                    onValueChange={(on) => void data.setMedia(on)}
                  />
                }
              />
              <Separator />
              <Row
                title={t("phoneDataSms")}
                hint={t(android ? "phoneDataSmsHint" : "phoneDataSmsIos")}
                right={
                  <Switch
                    label={t("phoneDataSms")}
                    value={android && data.prefs.smsCode}
                    disabled={!android || data.busy}
                    onValueChange={(on) => void data.setSmsCode(on)}
                  />
                }
              />
              {android && data.prefs.smsCode && (
                <>
                  <Separator />
                  <Row
                    title={t("phoneDataFallback")}
                    hint={
                      data.sms?.readSms === "undeclared"
                        ? t("phoneDataFallbackUnavailable")
                        : data.prefs.smsFallback && data.sms?.readSms === "denied"
                          ? t("phoneDataFallbackDenied")
                          : t("phoneDataFallbackHint")
                    }
                    right={
                      <Switch
                        label={t("phoneDataFallback")}
                        value={data.prefs.smsFallback}
                        disabled={data.busy || !data.sms || data.sms.readSms === "undeclared"}
                        onValueChange={(on) => void data.setFallback(on)}
                      />
                    }
                  />
                </>
              )}
              <AndroidCapabilityRows data={data} />
            </ListCard>
            <SectionTitle title={t("phoneDataRecent")} />
            <ListCard>
              {data.log.length === 0 ? (
                <Row title={t("phoneDataRecentEmpty")} />
              ) : (
                data.log.slice(0, 20).map((entry, index) => (
                  <View key={`${entry.at}:${entry.category}:${entry.outcome}`}>
                    {index > 0 && <Separator />}
                    <Row
                      title={t(logLabel[entry.category], { count: entry.count })}
                      hint={time.stamp(entry.at)}
                      right={
                        entry.outcome === "allowed" ? undefined : (
                          <Text style={{ fontSize: 12.5, color: colors.text2 }}>
                            {t("phoneDataLogRefused")}
                          </Text>
                        )
                      }
                    />
                  </View>
                ))
              )}
            </ListCard>
          </>
        )}
      </ScrollView>
    </View>
  );
}
