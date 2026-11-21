import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useRuntime, useText } from "../../runtime/context.tsx";
import { errorKey } from "../../runtime/errors.ts";
import { type } from "../../theme/scale.ts";
import { useColors } from "../../theme/use-theme.ts";
import { Button, ErrorLine, ListCard, SectionTitle, Switch } from "../../ui/controls.tsx";
import { Sheet, SheetText, SheetTitle } from "../../ui/sheet.tsx";
import type { EndpointRow, Scope } from "./model.ts";

const pageSize = 20;
const maxSelected = 1000;

function Choice({
  label,
  value,
  disabled,
  onValueChange,
}: {
  label: string;
  value: boolean;
  disabled: boolean;
  onValueChange: (value: boolean) => void;
}) {
  const colors = useColors();
  return (
    <View style={{ flexDirection: "row", minHeight: 42, alignItems: "center", gap: 12 }}>
      <Text style={[type.rowTitle, { flex: 1, color: colors.text }]}>{label}</Text>
      <Switch label={label} value={value} disabled={disabled} onValueChange={onValueChange} />
    </View>
  );
}

function ScopeField({
  kind,
  ids,
  change,
  disabled,
}: {
  kind: "botIds" | "groupIds";
  ids: string[] | null;
  change: (ids: string[] | null) => void;
  disabled: boolean;
}) {
  const runtime = useRuntime();
  const t = useText();
  const colors = useColors();
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [items, setItems] = useState<{ id: string; name: string }[]>();
  const [error, setError] = useState<ReturnType<typeof errorKey>>();
  const [retry, setRetry] = useState(0);
  const [atLimit, setAtLimit] = useState(false);
  const after = cursors.at(-1);
  const specific = ids !== null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry explicitly repeats this page.
  useEffect(() => {
    const owner = new AbortController();
    setItems(undefined);
    setError(undefined);
    if (specific) {
      void runtime
        .call(
          kind === "botIds" ? "bots.list" : "groups.list",
          { before: after, limit: pageSize },
          owner.signal,
        )
        .then((rows) => {
          if (!owner.signal.aborted) setItems(rows.map(({ id, name }) => ({ id, name })));
        })
        .catch((cause) => {
          if (!owner.signal.aborted) setError(errorKey(cause));
        });
    }
    return () => owner.abort();
  }, [after, kind, retry, runtime, specific]);

  const selected = new Set(ids);
  const last = items?.at(-1)?.id;
  return (
    <>
      <SectionTitle title={t(kind === "botIds" ? "endpointsBots" : "endpointsGroups")} />
      <ListCard style={{ padding: 12, gap: 10 }}>
        <Choice
          label={t("endpointsAll")}
          value={ids === null}
          disabled={disabled}
          onValueChange={(all) => {
            setCursors([undefined]);
            setAtLimit(false);
            change(all ? null : []);
          }}
        />
        {ids !== null && (
          <>
            <Text style={[type.caption, { color: colors.text2 }]}>
              {t(ids.length ? "endpointsSelected" : "endpointsNone", { count: ids.length })}
            </Text>
            <ErrorLine text={error && t(error)} />
            {error && <Button title={t("retry")} onPress={() => setRetry((n) => n + 1)} />}
            {!items && !error && <Text style={{ color: colors.text2 }}>{t("loading")}</Text>}
            {items?.map(({ id, name }) => (
              <Choice
                key={id}
                label={name}
                value={selected.has(id)}
                disabled={disabled}
                onValueChange={(on) => {
                  if (on && ids.length >= maxSelected) {
                    setAtLimit(true);
                    return;
                  }
                  setAtLimit(false);
                  change(on ? [...ids, id] : ids.filter((value) => value !== id));
                }}
              />
            ))}
            {atLimit && <ErrorLine text={t("endpointsScopeLimit", { count: maxSelected })} />}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {cursors.length > 1 && (
                <Button
                  title={t("endpointsPrev")}
                  onPress={() => setCursors((all) => all.slice(0, -1))}
                />
              )}
              {items?.length === pageSize && last && (
                <Button
                  title={t("endpointsNext")}
                  onPress={() => setCursors((all) => [...all, last])}
                />
              )}
            </View>
          </>
        )}
      </ListCard>
    </>
  );
}

export function EndpointScopeSheet({
  row,
  name,
  disabled,
  close,
  save,
}: {
  row: EndpointRow;
  name: string;
  disabled: boolean;
  close: () => void;
  save: (scope: Scope) => void;
}) {
  const t = useText();
  const [scope, setScope] = useState(row.scope);
  const unchanged = JSON.stringify(scope) === JSON.stringify(row.scope);
  return (
    <Sheet visible onClose={close}>
      <SheetTitle text={t("endpointsConfirm", { name })} />
      <SheetText text={t("endpointsScopeHint")} />
      {(["botIds", "groupIds"] as const).map((kind) => (
        <ScopeField
          key={kind}
          kind={kind}
          ids={scope[kind]}
          change={(ids) => setScope((old) => ({ ...old, [kind]: ids }))}
          disabled={disabled}
        />
      ))}
      <Button
        size="lg"
        variant="prim"
        title={t("save")}
        disabled={disabled || unchanged}
        onPress={() => save(scope)}
      />
      <Button size="lg" variant="ghost" title={t("cancel")} onPress={close} />
    </Sheet>
  );
}
