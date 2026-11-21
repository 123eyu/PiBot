import type { Permissions } from "@pibot/protocol";
import { layoutStyles, SettingsRow, useT } from "@pibot/renderer-kit";
import { Button, SegmentedControl } from "@pibot/ui";
import { useState } from "react";
import type { PermissionEditorProps } from "./permission-editor.ts";

type Runtime = NonNullable<Permissions["dockerRuntime"]>;

export function DockerPermissions({ data, disabled, save }: PermissionEditorProps) {
  const t = useT();
  const [pending, setPending] = useState<Runtime>();
  const platform = window.pibot.platform;
  const runtimes: { value: Runtime; label: string }[] = [
    { value: "disabled", label: t("docker.disabled") },
    ...(platform === "darwin" ? [{ value: "orbstack" as const, label: "OrbStack" }] : []),
    { value: "desktop", label: "Docker Desktop" },
    ...(platform === "linux" ? [{ value: "engine" as const, label: "Docker Engine" }] : []),
  ];
  const platformNote = t(
    platform === "win32" ? "docker.windows" : platform === "linux" ? "docker.linux" : "docker.mac",
  );
  // Its own row in 命令环境 (gaps-settings.html#a-docker); the risk and platform notes sit
  // behind ⓘ, and choosing a runtime asks for the confirmation in a line under the row.
  return (
    <>
      <SettingsRow
        icon="box"
        tone="blue"
        label={t("docker.title")}
        note={t("permissions.short.docker")}
        info={
          <>
            <p>{t("docker.risk")}</p>
            <p>{platformNote}</p>
            <p>{t("docker.lifecycle")}</p>
          </>
        }
      >
        <SegmentedControl
          label={t("docker.title")}
          value={pending ?? data.dockerRuntime ?? "disabled"}
          options={runtimes}
          disabled={disabled}
          onValueChange={(value) => {
            if (value === "disabled") {
              setPending(undefined);
              void save({ dockerRuntime: "disabled" });
            } else setPending(value);
          }}
        />
      </SettingsRow>
      {pending && (
        <div className={layoutStyles.banner} role="alert">
          <span>{t("docker.confirm")}</span>
          <Button
            className={layoutStyles.small}
            disabled={disabled}
            onClick={() =>
              void save({ dockerRuntime: pending }).then((ok) => {
                if (ok) setPending(undefined);
              })
            }
          >
            {t("docker.enable")}
          </Button>
          <Button
            variant="ghost"
            className={layoutStyles.small}
            disabled={disabled}
            onClick={() => setPending(undefined)}
          >
            {t("common.cancel")}
          </Button>
        </div>
      )}
    </>
  );
}
