import type { MemoryOwner, MethodParams, MethodResults } from "@pibot/protocol";
import { useRpc, useRpcEvent } from "@pibot/renderer-kit";
import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";
import { useMemoryCursor } from "./MemoryPagination.tsx";
import { memoryErrorKey } from "./memory-error.ts";

type Setter<T> = Dispatch<SetStateAction<T>>;
interface MemoryScopeState {
  peer: ReturnType<typeof useRpc>["peer"];
  data: MethodResults["memory.browse"] | undefined;
  state: "active" | "archived" | "all";
  setState: Setter<"active" | "archived" | "all">;
  itemsCursor: ReturnType<typeof useMemoryCursor>;
  proposalsCursor: ReturnType<typeof useMemoryCursor>;
  undoCursor: ReturnType<typeof useMemoryCursor>;
  loading: boolean;
  busy: boolean;
  disabled: boolean;
  failed: boolean;
  operationError: ReturnType<typeof memoryErrorKey> | undefined;
  clearing: number | undefined;
  setClearing: Setter<number | undefined>;
  toast: string | undefined;
  adding: boolean;
  setAdding: Setter<boolean>;
  showUndo: boolean;
  setShowUndo: Setter<boolean>;
  operation(work: (signal: AbortSignal) => Promise<unknown>): Promise<boolean>;
  change(change: MethodParams["memory.manage"]["change"]): Promise<boolean>;
  reload(): void;
  setTransferBusy: Setter<boolean>;
}

export function useMemoryScope(owner: MemoryOwner): MemoryScopeState {
  const { peer } = useRpc();
  const [state, setState] = useState<"active" | "archived" | "all">("active");
  const [adding, setAdding] = useState(false);
  const [showUndo, setShowUndo] = useState(false);
  const [toast, setToast] = useState<string>();
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(undefined), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
  const itemsCursor = useMemoryCursor();
  const proposalsCursor = useMemoryCursor();
  const undoCursor = useMemoryCursor();
  const before = itemsCursor.before;
  const proposalsBefore = proposalsCursor.before;
  const undoBefore = undoCursor.before;
  const [snapshot, setSnapshot] = useState<{
    peer: typeof peer;
    page: string;
    value: MethodResults["memory.browse"];
  }>();
  const pageKey = JSON.stringify([
    owner.scope,
    owner.ownerId,
    state,
    before,
    proposalsBefore,
    undoBefore,
  ]);
  const data = snapshot?.peer === peer && snapshot.page === pageKey ? snapshot.value : undefined;
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [transferBusy, setTransferBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [operationError, setOperationError] = useState<ReturnType<typeof memoryErrorKey>>();
  const [revision, setRevision] = useState(0);
  const [clearing, setClearing] = useState<number>();
  const lock = useRef<AbortController | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const reload = () => {
    setRevision((n) => n + 1);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: A connection change retires pending work and scoped data.
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    setSnapshot(undefined);
    setAdding(false);
    setToast(undefined);
    setClearing(undefined);
    setOperationError(undefined);
    setShowUndo(false);
    setState("active");
    itemsCursor.reset();
    proposalsCursor.reset();
    undoCursor.reset();
    setBusy(false);
    setFailed(false);
    return () => {
      controller.abort();
      lifetime.current = null;
    };
  }, [peer, owner.scope, owner.ownerId]);
  useRpcEvent("memory.changed", (event) => {
    if (event.scope === owner.scope && event.ownerId === owner.ownerId) reload();
  });
  useRpcEvent("groups.resources.changed", (event) => {
    if (owner.scope === "group" && event.groupId === owner.ownerId && event.kind === "memory")
      reload();
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: Revision refetches scoped state after a mutation or event.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    if (peer)
      void peer
        .call(
          "memory.browse",
          {
            scope: owner.scope,
            ownerId: owner.ownerId,
            before,
            proposalsBefore,
            undoBefore,
            state,
          },
          { signal: controller.signal, timeoutMs: 30_000 },
        )
        .then((result) => {
          if (!controller.signal.aborted)
            setSnapshot({
              peer,
              page: JSON.stringify([
                owner.scope,
                owner.ownerId,
                state,
                before,
                proposalsBefore,
                undoBefore,
              ]),
              value: result,
            });
        })
        .catch(() => {
          if (!controller.signal.aborted) setFailed(true);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    else {
      setLoading(false);
      setFailed(true);
    }
    return () => controller.abort();
  }, [peer, owner.scope, owner.ownerId, state, before, proposalsBefore, undoBefore, revision]);
  const operation = async (work: (signal: AbortSignal) => Promise<unknown>) => {
    const controller = lifetime.current;
    if (
      (lock.current && !lock.current.signal.aborted) ||
      !controller ||
      !peer ||
      controller.signal.aborted
    )
      return false;
    lock.current = controller;
    setBusy(true);
    setFailed(false);
    setOperationError(undefined);
    try {
      await work(controller.signal);
      if (controller.signal.aborted) return false;
      setClearing(undefined);
      reload();
      return true;
    } catch (error) {
      if (!controller.signal.aborted) {
        setFailed(true);
        setOperationError(memoryErrorKey(error));
        reload();
      }
      return false;
    } finally {
      if (lock.current === controller) lock.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const change = (change: MethodParams["memory.manage"]["change"]) =>
    operation(async (signal) => {
      const result = await peer?.call(
        "memory.manage",
        { scope: owner.scope, ownerId: owner.ownerId, confirmed: true, change },
        { signal, timeoutMs: 30_000 },
      );
      signal.throwIfAborted();
      if (result?.undoProposalId) setToast(result.undoProposalId);
      if (change.action === "undo" || change.action === "clear") setToast(undefined);
      if (change.action === "clear") {
        itemsCursor.reset();
        proposalsCursor.reset();
        undoCursor.reset();
      }
    });
  const disabled = busy || transferBusy || !peer;
  return {
    peer,
    data,
    state,
    setState,
    itemsCursor,
    proposalsCursor,
    undoCursor,
    loading,
    busy,
    disabled,
    failed,
    operationError,
    clearing,
    setClearing,
    toast,
    adding,
    setAdding,
    showUndo,
    setShowUndo,
    operation,
    change,
    reload,
    setTransferBusy,
  };
}
