import { open } from "node:fs/promises";
import { type NetworkProxy, withPublicDownload } from "@pibot/execution";
import { SKILL_IMPORT_MAX_BYTES } from "@pibot/skills-contract/full";
import { checkStatus, type LinkSource, linkError, responseSize } from "./link-source.ts";

/** Disk bytes are bounded independently of HEAD and GET headers; the source owner removes failures. */
export async function downloadArchive(
  path: string,
  source: LinkSource,
  signal: AbortSignal,
  progress: (bytes: number, total: number | null) => void,
  proxy?: NetworkProxy,
  request: typeof withPublicDownload = withPublicDownload,
  confirmedBytes: number | null = null,
) {
  const file = await open(path, "wx", 0o600);
  try {
    await request(
      {
        url: source.download,
        hosts: source.hosts,
        method: "GET",
        signal,
        ...(proxy ? { proxy } : {}),
      },
      async (response) => {
        checkStatus(response.status);
        const length = response.headers.get("content-length");
        if (
          confirmedBytes !== null &&
          length !== null &&
          /^\d+$/.test(length) &&
          Number(length) > confirmedBytes
        )
          throw linkError("skill_link_size_changed");
        const expected = responseSize(length);
        const encoding = response.headers.get("content-encoding");
        if ((encoding && encoding !== "identity") || !response.body)
          throw linkError("skill_link_download_failed");
        let bytes = 0;
        progress(bytes, expected);
        for await (const chunk of response.body) {
          signal.throwIfAborted();
          bytes += chunk.length;
          progress(bytes, expected);
          if (confirmedBytes !== null && bytes > confirmedBytes)
            throw linkError("skill_link_size_changed");
          if (bytes > SKILL_IMPORT_MAX_BYTES) throw linkError("skill_import_too_large");
          await file.writeFile(chunk);
        }
        if (expected !== null && bytes !== expected) throw linkError("skill_link_download_failed");
      },
    );
  } finally {
    await file.close();
  }
}
