import {
  type Permissions,
  type RoutinePreauthInput,
  RoutinePreauthInputSchema,
} from "@pibot/protocol";
import { useT } from "@pibot/renderer-kit";
import routineStyles from "../shell/routines.module.css";
import { PreauthRow } from "./PreauthRow.tsx";

const isPaid = (op: RoutinePreauthInput) => op.category === "web" && op.scope.kind === "paid_image";

/**
 * Owner decision 2026-10-23: an image Bot's routine can pre-approve paid generation for the
 * Bot's current model, so a scheduled run doesn't wait for a card. Changing the model voids it
 * (brain matches the exact model on save and on every generation).
 */
export function PaidImagePreauth({
  selected,
  change,
  permissions,
  model,
}: {
  selected: RoutinePreauthInput[];
  change(ops: RoutinePreauthInput[]): void;
  permissions?: Permissions;
  model?: { provider: string; id: string };
}) {
  const t = useT();
  const chosen = selected.filter(isPaid);
  if (!model && !chosen.length) return null;
  const parsed =
    model &&
    RoutinePreauthInputSchema.safeParse({
      category: "web",
      scope: { kind: "paid_image", provider: model.provider, model: model.id },
    });
  const op = parsed?.success ? parsed.data : undefined;
  const name = model ? `${model.provider} / ${model.id}` : "";
  const current =
    !!op &&
    chosen.some(
      (item) =>
        item.scope.kind === "paid_image" &&
        item.scope.provider === model?.provider &&
        item.scope.model === model?.id,
    );
  // A pre-approval saved for an earlier model no longer applies; it is listed so it can be removed.
  const stale = chosen.filter(
    (item) =>
      item.scope.kind === "paid_image" &&
      (item.scope.provider !== model?.provider || item.scope.model !== model?.id),
  );
  const never = permissions?.effective?.levels.web === "never";
  return (
    <fieldset className={routineStyles.stack}>
      <legend>{t("routines.paidImage.title")}</legend>
      <p className={routineStyles.note}>{t("routines.paidImage.note")}</p>
      {(op || stale.length > 0) && (
        <div className={routineStyles.optRows}>
          {op && (
            <PreauthRow
              kind="paid_image"
              label={t("routines.paidImage.allow", { model: name })}
              checked={current}
              disabled={!current && (never || selected.length >= 200)}
              change={(on) =>
                change(
                  on
                    ? [...selected.filter((item) => !isPaid(item)), op]
                    : selected.filter((item) => !isPaid(item)),
                )
              }
            />
          )}
          {stale.map((item) => (
            <PreauthRow
              key={JSON.stringify(item)}
              kind="paid_image"
              label={
                item.scope.kind === "paid_image"
                  ? t("routines.paidImage.allow", {
                      model: `${item.scope.provider} / ${item.scope.model}`,
                    })
                  : ""
              }
              problem={t("routines.paidImage.stale")}
              checked
              change={() => change(selected.filter((entry) => entry !== item))}
            />
          ))}
        </div>
      )}
    </fieldset>
  );
}
