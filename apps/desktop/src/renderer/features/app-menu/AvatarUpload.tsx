import { useT } from "@pibot/renderer-kit";
import { Button, Icon } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import styles from "./app-menu.module.css";
import { normalizeAvatar } from "./avatar-image.ts";

export function AvatarUpload({
  image,
  disabled,
  change,
}: {
  image?: string | null;
  disabled?: boolean;
  change(image: string | null): Promise<boolean>;
}) {
  const t = useT(),
    input = useRef<HTMLInputElement>(null),
    locked = useRef(false),
    lifetime = useRef<AbortController | undefined>(undefined);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  const apply = async (file?: File) => {
    if (locked.current || disabled) return;
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    locked.current = true;
    setBusy(true);
    setError(false);
    try {
      const image = file ? await normalizeAvatar(file, signal) : null;
      signal.throwIfAborted();
      if ((await change(image)) === false) throw new Error("avatar_save_failed");
    } catch {
      if (!signal.aborted) setError(true);
    } finally {
      locked.current = false;
      if (!signal.aborted) setBusy(false);
    }
  };
  return (
    <div className={styles.upload}>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        disabled={busy || disabled}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void apply(file);
        }}
      />
      <div className={styles.actions}>
        <Button
          variant="secondary"
          disabled={disabled || busy}
          loading={busy}
          onClick={() => input.current?.click()}
        >
          <Icon name="image" />
          {t("appMenu.uploadAvatar")}
        </Button>
        {image && (
          <Button variant="ghost" disabled={disabled || busy} onClick={() => void apply()}>
            {t("appMenu.restoreAvatar")}
          </Button>
        )}
      </div>
      <p className={styles.note}>{t("appMenu.avatarHint")}</p>
      {error && (
        <p role="alert" className={styles.error}>
          {t("appMenu.avatarError")}
        </p>
      )}
    </div>
  );
}
