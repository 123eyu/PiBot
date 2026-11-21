import { useLayoutEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { externalUrl } from "../chat/messages/Markdown.tsx";
import { remarkCjkStrong } from "../chat/messages/markdown-cjk-strong.ts";
import type { ViewerProps } from "./engine.ts";
import styles from "./preview.module.css";
export default function TextViewer({ file, result, update, ready }: ViewerProps) {
  const host = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: restore once per mounted file
  useLayoutEffect(() => {
    ready?.();
    host.current?.scrollTo(file.reading.x, file.reading.y);
  }, []);
  return (
    <div
      className={styles.canvasHost}
      ref={host}
      onScroll={(event) =>
        update(file.key, { x: event.currentTarget.scrollLeft, y: event.currentTarget.scrollTop })
      }
    >
      <article className={styles.markdown} style={{ fontSize: 14 * file.reading.zoom }}>
        <ReactMarkdown
          skipHtml
          remarkPlugins={[remarkGfm, remarkCjkStrong]}
          components={{
            img: ({ alt }) => <span>{alt}</span>,
            a: ({ href, children }) => {
              const url = externalUrl(href);
              return url ? (
                <a
                  href={url}
                  rel="noreferrer"
                  onClick={(event) => {
                    event.preventDefault();
                    window.open(url, "_blank", "noopener,noreferrer");
                  }}
                >
                  {children}
                </a>
              ) : (
                <span>{children}</span>
              );
            },
          }}
        >
          {result.text ?? ""}
        </ReactMarkdown>
      </article>
    </div>
  );
}
