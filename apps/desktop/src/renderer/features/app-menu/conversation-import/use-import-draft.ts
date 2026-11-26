import { useRpc, useWorkspace } from "@pibot/renderer-kit";
import { useEffect, useRef, useState } from "react";
import {
  type Preview,
  type Project,
  type Quote,
  reviewOptions,
  type Scope,
  type Selection,
  type Source,
  selection,
  startError,
} from "./import-state.ts";

type ReviewAction = "preview" | "memory" | "persona" | "project" | "quote";

export function useImportDraft() {
  const { peer } = useRpc();
  const workspace = useWorkspace();
  const bots = workspace.bots.filter(({ archivedAt }) => !archivedAt);
  const [source, setSource] = useState<Source>("chatgpt");
  const [preview, setPreview] = useState<Preview>();
  const [botId, setBotId] = useState("");
  const [conversations, setConversations] = useState(true);
  const [scope, setScope] = useState<Exclude<Scope, "persona">>("user");
  const [memories, setMemories] = useState<Selection>();
  const [persona, setPersona] = useState<Selection>();
  const [project, setProject] = useState<Project>();
  const [projectConfirmed, setProjectConfirmed] = useState(false);
  const [quote, setQuote] = useState<Quote>();
  const [quoteUnavailable, setQuoteUnavailable] = useState(false);
  const [busy, setBusy] = useState<ReviewAction>();
  const [error, setError] = useState<ReturnType<typeof startError>>();
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => request.current?.abort(), []);

  const clearSelections = () => {
    setMemories(undefined);
    setPersona(undefined);
    setQuote(undefined);
    setQuoteUnavailable(false);
    setProject(undefined);
    setProjectConfirmed(false);
    setError(undefined);
  };

  const run = async (kind: ReviewAction, work: (signal: AbortSignal) => Promise<void>) => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(kind);
    setError(undefined);
    try {
      await work(controller.signal);
    } catch (failure) {
      if (!controller.signal.aborted) setError(startError(failure));
    } finally {
      if (request.current === controller) request.current = undefined;
      if (!controller.signal.aborted) setBusy(undefined);
    }
  };

  function pick() {
    if (!peer) return;
    void run("preview", async (signal) => {
      // preview performs source detection and opens the native picker only after this click.
      const next = await peer.call("import.preview", { source }, { ...reviewOptions, signal });
      if (signal.aborted || !next) return;
      clearSelections();
      setPreview(next);
      setConversations(next.topics > 0);
      setScope("user");
      setBotId(bots.find((bot) => bot.isMain)?.id ?? bots[0]?.id ?? "");
    });
  }

  const selectedBot = bots.find((bot) => bot.id === botId)?.id ?? "";
  function review(kind: "memory" | "persona") {
    if (!peer || !preview || !selectedBot) return;
    const target = kind === "memory" ? scope : "persona";
    const update = kind === "memory" ? setMemories : setPersona;
    void run(kind, async (signal) => {
      // Backend replaces that review slot when requested, even if the new reply fails.
      update(undefined);
      const result = await peer.call(
        "import.reviewMemories",
        { importId: preview.importId, botId: selectedBot, scope: target },
        { ...reviewOptions, signal },
      );
      if (!signal.aborted) update(selection(result, target));
    });
  }

  function reviewProject() {
    if (!peer || !preview || !selectedBot) return;
    void run("project", async (signal) => {
      setProject(undefined);
      setProjectConfirmed(false);
      const result = await peer.call(
        "import.reviewProject",
        { importId: preview.importId },
        { ...reviewOptions, signal },
      );
      if (!signal.aborted && result) setProject(result);
    });
  }

  function toggleQuote(enabled: boolean) {
    setQuote(undefined);
    setQuoteUnavailable(false);
    if (!enabled || !conversations || !selectedBot || !peer || !preview) return;
    void run("quote", async (signal) => {
      const result = await peer.call(
        "import.estimateDistillation",
        { importId: preview.importId, botId: selectedBot },
        { signal },
      );
      if (!signal.aborted) {
        setQuote(result ?? undefined);
        setQuoteUnavailable(!result);
      }
    });
  }

  return {
    preview,
    source,
    bots,
    moreBots: workspace.hasMoreBots ? workspace.moreBots : undefined,
    botId: selectedBot,
    conversations,
    scope,
    memories,
    persona,
    project,
    projectConfirmed,
    quote,
    quoteUnavailable,
    busy,
    error,
    pick,
    review,
    reviewProject,
    toggleQuote,
    setMemories,
    setPersona,
    setProjectConfirmed,
    selectSource(value: Source) {
      setSource(value);
      setError(undefined);
    },
    changeBot(value: string) {
      setBotId(value);
      clearSelections();
    },
    changeScope(value: Exclude<Scope, "persona">) {
      setScope(value);
      setMemories(undefined);
      setError(undefined);
    },
    changeConversations(value: boolean) {
      setConversations(value);
      if (!value) toggleQuote(false);
    },
    back() {
      setPreview(undefined);
      clearSelections();
    },
  };
}

export type ImportDraft = ReturnType<typeof useImportDraft>;
