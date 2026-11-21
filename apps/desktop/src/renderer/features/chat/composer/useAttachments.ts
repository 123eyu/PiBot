import type { TranslationKey } from "@pibot/i18n";
import {
  type AttachmentInput,
  AttachmentInputSchema,
  FILE_LIMIT,
  fileMime,
  IMAGE_LIMIT,
  type IMAGE_MIMES,
  MAX_ATTACHMENTS,
} from "@pibot/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface DraftAttachment {
  id: string;
  input: AttachmentInput;
}
export interface AttachmentIssue {
  id: string;
  name: string;
  key: TranslationKey;
}
function readFile(file: File, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => reader.abort();
    const timer = setTimeout(abort, 15_000);
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    reader.onload = () => {
      cleanup();
      resolve(String(reader.result).split(",")[1] ?? "");
    };
    reader.onerror = reader.onabort = () => {
      cleanup();
      reject(new Error("Attachment read failed"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      cleanup();
      reject(new Error("Attachment read canceled"));
    } else reader.readAsDataURL(file);
  });
}
export function useAttachments(
  supportsImages: boolean,
  disabled: boolean,
  initial: AttachmentInput[] = [],
) {
  const [drafts, setDrafts] = useState<DraftAttachment[]>(() =>
    initial.map((input) => ({ id: crypto.randomUUID(), input })),
  );
  const [issues, setIssues] = useState<AttachmentIssue[]>([]);
  const [reading, setReading] = useState(false);
  const current = useRef(drafts);
  const capabilities = useRef({ supportsImages, disabled });
  capabilities.current = { supportsImages, disabled };
  const lifetime = useRef<AbortController | undefined>(undefined);
  const locked = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  const replace = useCallback((value: DraftAttachment[]) => {
    current.current = value;
    setDrafts(value);
  }, []);
  const add = useCallback(
    async (files: File[]) => {
      const signal = lifetime.current?.signal;
      if (
        !signal ||
        signal.aborted ||
        locked.current ||
        capabilities.current.disabled ||
        !files.length
      )
        return;
      locked.current = true;
      setReading(true);
      setIssues([]);
      const rejected: AttachmentIssue[] = [];
      const report = (file: File, key: TranslationKey) => {
        rejected.push({ id: crypto.randomUUID(), name: file.name, key });
      };
      try {
        for (const file of files) {
          if (signal.aborted || capabilities.current.disabled) break;
          if (current.current.length >= MAX_ATTACHMENTS) {
            report(file, "attachments.tooMany");
            continue;
          }
          const ext = file.name.split(".").at(-1)?.toLowerCase();
          const imageTypes: Record<string, (typeof IMAGE_MIMES)[number]> = {
            png: "image/png",
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
            webp: "image/webp",
            gif: "image/gif",
          };
          const image = ext && Object.hasOwn(imageTypes, ext) ? imageTypes[ext] : undefined;
          const mimeType = image ?? fileMime(file.name);
          if (!mimeType) {
            report(file, "attachments.unsupported");
            continue;
          }
          if (image && !capabilities.current.supportsImages) {
            report(file, "attachments.imageUnsupported");
            continue;
          }
          if (file.size > (image ? IMAGE_LIMIT : FILE_LIMIT)) {
            report(file, image ? "attachments.imageTooLarge" : "attachments.fileTooLarge");
            continue;
          }
          try {
            const data = await readFile(file, signal);
            if (signal.aborted || capabilities.current.disabled) break;
            const input = AttachmentInputSchema.safeParse({
              kind: image ? "image" : "file",
              name: file.name,
              mimeType,
              data,
            });
            if (!input.success) {
              report(file, "attachments.invalid");
              continue;
            }
            replace([...current.current, { id: crypto.randomUUID(), input: input.data }]);
          } catch {
            // A failed read must not discard the remaining files in the same drop.
            if (!signal.aborted) report(file, "attachments.readFailed");
          }
        }
      } finally {
        locked.current = false;
        if (!signal.aborted) {
          setIssues(rejected);
          setReading(false);
        }
      }
    },
    [replace],
  );
  // A stable result keeps send() stable, which keeps every memoized ChatMessage from re-rendering.
  return useMemo(
    () => ({
      drafts,
      issues,
      reading,
      add,
      dismissIssue: (id: string) => setIssues((items) => items.filter((item) => item.id !== id)),
      clear: () => {
        replace([]);
        setIssues([]);
      },
      remove: (id: string) => replace(current.current.filter((item) => item.id !== id)),
    }),
    [drafts, issues, reading, add, replace],
  );
}
