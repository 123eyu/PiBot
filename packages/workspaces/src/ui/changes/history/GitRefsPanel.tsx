import { Button, SegmentedControl, TextField } from "@pibot/ui";
import { GitRefNameSchema, type MethodResults } from "@pibot/workspaces-contract/full";
import { useEffect, useRef, useState } from "react";
import { changesErrorKey } from "../model.ts";
import type { ChangesPaneModel } from "../use-changes-pane.ts";
import styles from "./GitRefsPanel.module.css";

type Ref = MethodResults["changes.refs"]["refs"][number];

/** A local-only surface; changing repositories remounts it and drops the old request state. */
export function GitRefsPanel({ model, back }: { model: ChangesPaneModel; back(): void }) {
  const { t } = model;
  const [kind, setKind] = useState<"branch" | "tag">("branch");
  const [refs, setRefs] = useState<Ref[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [writable, setWritable] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ReturnType<typeof changesErrorKey>>();
  const [done, setDone] = useState(false);
  const [version, setVersion] = useState(0);
  const generation = useRef(0);
  const lifetime = useRef(new AbortController());
  const git = model.git?.state === "repo" ? model.git : undefined;
  const peer = model.peer;
  const targetKey = JSON.stringify(model.target);
  const head = git?.head;
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh refs after a write or HEAD change.
  useEffect(() => {
    const controller = new AbortController();
    const current = ++generation.current;
    setLoading(true);
    setWritable(false);
    setRefs([]);
    setNext(null);
    setError(undefined);
    void peer
      .call("changes.refs", { ...JSON.parse(targetKey), kind }, { signal: controller.signal })
      .then((page) => {
        if (current !== generation.current || controller.signal.aborted) return;
        setRefs(page.refs);
        setNext(page.next);
        setWritable(page.writable);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(changesErrorKey(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [peer, targetKey, kind, head, version]);
  const blocked = busy || loading || model.running || !writable || !head;
  const create = kind === "branch" ? "createBranch" : "createTag";
  const selectedCommit = kind === "tag" ? (model.commit?.oid ?? head) : head;
  const act = async (
    action: "createBranch" | "switchBranch" | "createTag",
    refName: string,
    commit: string,
  ) => {
    if (blocked || !git || !head) return;
    setBusy(true);
    setError(undefined);
    setDone(false);
    try {
      await peer.call(
        "changes.refWrite",
        {
          ...model.target,
          action,
          name: refName,
          commit,
          head,
          branch: git.branch,
        },
        { signal: lifetime.current.signal, timeoutMs: 200_000 },
      );
      if (lifetime.current.signal.aborted) return;
      setName("");
      setDone(true);
      if (action === "switchBranch") model.setScope("uncommitted");
      setVersion((value) => value + 1);
    } catch (failure) {
      if (!lifetime.current.signal.aborted) setError(changesErrorKey(failure));
    } finally {
      model.source?.refresh();
      if (!lifetime.current.signal.aborted) setBusy(false);
    }
  };
  return (
    <section className={styles.panel}>
      <Button variant="ghost" disabled={busy} onClick={back}>
        {t("agentWork.backToChanges")}
      </Button>
      <h3>{t("changes.refs.title")}</h3>
      <SegmentedControl
        label={t("changes.refs.title")}
        value={kind}
        options={[
          { value: "branch", label: t("changes.refs.branches") },
          { value: "tag", label: t("changes.refs.tags") },
        ]}
        onValueChange={(value) => {
          if (!busy) {
            setKind(value);
            setName("");
            setDone(false);
          }
        }}
      />
      <p className={styles.hint}>{t("changes.refs.localOnly")}</p>
      {!loading && !writable && <p className={styles.hint}>{t("changes.refs.readonly")}</p>}
      {model.running && <p className={styles.hint}>{t("changes.error.changes_busy")}</p>}
      {git && (
        <p className={styles.hint}>
          {t("changes.refs.current", { name: git.branch ?? t("changes.repo.detached") })}
        </p>
      )}
      {writable && head && (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            if (selectedCommit) void act(create, name.trim(), selectedCommit);
          }}
        >
          <TextField
            label={t(kind === "branch" ? "changes.refs.newBranch" : "changes.refs.newTag")}
            value={name}
            maxLength={200}
            disabled={busy || model.running}
            onChange={(event) => setName(event.target.value)}
            description={t("changes.refs.nameHelp")}
          />
          <span className={styles.hint}>
            {t("changes.refs.fromCommit", { oid: selectedCommit?.slice(0, 8) ?? "" })}
          </span>
          <Button
            type="submit"
            disabled={!!blocked || !GitRefNameSchema.safeParse(name.trim()).success}
          >
            {t(kind === "branch" ? "changes.refs.createBranch" : "changes.refs.createTag")}
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {t(error)}{" "}
          <Button variant="ghost" disabled={busy} onClick={() => setVersion((value) => value + 1)}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      {done && (
        <p role="status" className={styles.hint}>
          {t("changes.refs.done")}
        </p>
      )}
      {loading && !refs.length ? (
        <p role="status">{t("common.loading")}</p>
      ) : !refs.length && !error ? (
        <p className={styles.hint}>{t("changes.refs.empty")}</p>
      ) : null}
      <ul className={styles.list}>
        {refs.map((ref) => (
          <li key={ref.name}>
            <div className={styles.name}>
              <b>{ref.name}</b>
              <span className={styles.hint}>
                {ref.oid.slice(0, 8)}
                {ref.occupied ? ` · ${t("changes.refs.occupied")}` : ""}
              </span>
            </div>
            {kind === "branch" && ref.name !== git?.branch && (
              <Button
                variant="secondary"
                disabled={
                  !!blocked || ref.occupied || !GitRefNameSchema.safeParse(ref.name).success
                }
                onClick={() => void act("switchBranch", ref.name, ref.oid)}
              >
                {t("changes.refs.switch")}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {next && (
        <Button
          variant="ghost"
          disabled={busy || loading}
          onClick={async () => {
            const current = generation.current;
            setLoading(true);
            setError(undefined);
            try {
              const page = await peer.call(
                "changes.refs",
                { ...model.target, kind, after: next },
                { signal: lifetime.current.signal },
              );
              if (lifetime.current.signal.aborted || current !== generation.current) return;
              setRefs((current) => [
                ...new Map([...current, ...page.refs].map((ref) => [ref.name, ref])).values(),
              ]);
              setNext(page.next);
            } catch (failure) {
              if (!lifetime.current.signal.aborted && current === generation.current)
                setError(changesErrorKey(failure));
            } finally {
              if (!lifetime.current.signal.aborted && current === generation.current)
                setLoading(false);
            }
          }}
        >
          {t("changes.refs.more")}
        </Button>
      )}
    </section>
  );
}
