import { useEffect, useState } from "react";
import { useLinkState, useRuntime, useText } from "../../../runtime/context.tsx";
import { Button, ErrorLine, FootNote, ListCard } from "../../../ui/controls.tsx";
import { OptionRow, SheetText } from "../../../ui/sheet.tsx";
import { useDevicePage } from "../../endpoints/use-device-page.ts";
import { useRemoteValue } from "../controls/use-remote-value.ts";
import type { ChatPage } from "../use-chat-page.ts";

function Browser({
  page,
  location,
  close,
  done,
}: {
  page: ChatPage;
  location: string;
  close(): void;
  done(): void;
}) {
  const t = useText();
  const runtime = useRuntime();
  const [owner] = useState(() => new AbortController());
  useEffect(() => () => owner.abort(), [owner]);
  const [path, setPath] = useState<string | null>();
  const listing = useRemoteValue(
    `runner-folder:${location}:${path === undefined ? "start" : (path ?? "root")}`,
    (signal) => runtime.call("workplaces.browse", { location, path }, signal),
  );
  const value = listing.value;
  const primary = page.workplace.value?.folders.find(
    (f) => f.id === page.workplace.value?.folderId,
  );
  const disabled = !page.online || page.workplace.write.busy || listing.action.busy || !value?.path;
  const pick = async (readonly: boolean) => {
    if (!value?.path) return;
    if (await page.workplace.pickRunner(location, value.path, readonly, owner.signal)) done();
  };
  return (
    <>
      <SheetText text={value?.path ?? t("runnerFolder")} />
      <ErrorLine text={listing.action.error && t(listing.action.error)} />
      <ErrorLine text={page.workplace.write.error && t(page.workplace.write.error)} />
      {listing.action.busy && <FootNote text={t("loading")} />}
      <Button title={t("retry")} disabled={!page.online} onPress={() => void listing.load()} />
      {value && (
        <>
          <Button
            title={t("runnerFolderParent")}
            disabled={!page.online || listing.action.busy || value.top}
            onPress={() => setPath(value.parent)}
          />
          <ListCard flush>
            {value.folders.map((folder) => (
              <OptionRow
                key={folder.path}
                title={folder.name}
                disabled={!page.online || listing.action.busy}
                onPress={() => setPath(folder.path)}
              />
            ))}
          </ListCard>
          {value.truncated && <FootNote text={t("runnerFolderTruncated")} />}
          <Button
            title={t("runnerFolderUse")}
            disabled={disabled}
            onPress={() => void pick(false)}
          />
          {primary?.location === location && (
            <Button
              title={t("runnerFolderReadonly")}
              disabled={disabled || primary.path === value.path}
              onPress={() => void pick(true)}
            />
          )}
        </>
      )}
      <Button title={t("cancel")} disabled={page.workplace.write.busy} onPress={close} />
    </>
  );
}

export function RunnerFolderSheet({ page, done }: { page: ChatPage; done(): void }) {
  const t = useText();
  const mobile = useLinkState();
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const devices = useDevicePage(cursors.at(-1), 10);
  const [location, setLocation] = useState<string>();
  if (location)
    return (
      <Browser
        key={`${mobile.selectedId}:${location}`}
        page={page}
        location={location}
        close={() => setLocation(undefined)}
        done={done}
      />
    );
  return (
    <>
      <SheetText text={t("runnerFolder")} />
      <ErrorLine text={devices.action.error && t(devices.action.error)} />
      <ListCard flush>
        {devices.value?.items
          .filter((d) => d.kind === "runner")
          .map((d) => (
            <OptionRow
              key={d.id}
              title={d.name}
              subtitle={t(d.online && devices.online ? "deviceOnline" : "deviceOffline")}
              disabled={
                !devices.online ||
                devices.stale ||
                devices.action.busy ||
                !!devices.action.error ||
                !d.online ||
                !d.target
              }
              onPress={() => setLocation(d.target)}
            />
          ))}
      </ListCard>
      <Button
        title={t("endpointsPrev")}
        disabled={cursors.length <= 1 || devices.action.busy}
        onPress={() => setCursors((v) => v.slice(0, -1))}
      />
      <Button
        title={t("endpointsNext")}
        disabled={!devices.value?.nextAfter || devices.action.busy}
        onPress={() => {
          const cursor = devices.value?.nextAfter;
          if (cursor) setCursors((v) => [...v, cursor]);
        }}
      />
    </>
  );
}
