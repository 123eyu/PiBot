import { indexLog } from "./index-log.ts";

self.onmessage = (event: MessageEvent<{ text: string; query: string; wrap: number }>) => {
  const { text, query, wrap } = event.data;
  const index = indexLog(text, query, wrap);
  self.postMessage(index, {
    transfer: [index.rows.buffer, index.matches.buffer, index.points.buffer, index.anchors.buffer],
  });
};
