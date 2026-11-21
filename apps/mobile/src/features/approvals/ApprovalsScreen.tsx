import { useRouter } from "expo-router";
import { RefreshControl, ScrollView, View } from "react-native";
import { useLinkState, useText } from "../../runtime/context.tsx";
import { space } from "../../theme/scale.ts";
import { useColors } from "../../theme/use-theme.ts";
import { Button, EmptyState, ErrorLine, FootNote } from "../../ui/controls.tsx";
import { OfflineBanner, TabHeader } from "../../ui/headers.tsx";
import { useTabBarInset } from "../../ui/tab-bar.tsx";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { useApprovals } from "./approvals-context.tsx";

export function ApprovalsScreen() {
  const colors = useColors(),
    t = useText(),
    router = useRouter(),
    mobile = useLinkState(),
    approvals = useApprovals(),
    tabInset = useTabBarInset();
  const items = approvals.items;
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <TabHeader
        title={t("approvals")}
        tab="approvals"
        subtitle={
          items.length ? t("approvalsWaitingLine", { count: items.length }) : t("approvalsNone")
        }
      />
      <ScrollView
        contentContainerStyle={{ paddingBottom: tabInset, gap: 10 }}
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={() => void approvals.load()}
            tintColor={colors.text2}
          />
        }
      >
        {mobile.status !== "online" && (
          <View style={{ marginHorizontal: space.page, marginTop: 2, marginBottom: 2 }}>
            <OfflineBanner text={t("approvalsOffline")} />
          </View>
        )}
        <ErrorLine text={approvals.action.error && t(approvals.action.error)} />
        {items.length > 0 ? (
          <>
            {items.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                onOpen={() => router.push(`/approval/${approval.id}`)}
              />
            ))}
            {approvals.hasMore && (
              <Button
                title={t("loadEarlier")}
                style={{ alignSelf: "center", marginTop: 12 }}
                onPress={() => void approvals.load(true)}
              />
            )}
            <FootNote text={t("approvalsFoot")} />
          </>
        ) : (
          !approvals.action.busy && (
            <EmptyState icon="inbox" title={t("approvalsEmpty")} hint={t("approvalsEmptyHint")} />
          )
        )}
      </ScrollView>
    </View>
  );
}
