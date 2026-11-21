import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";

const recordName = "release-package.json";
const ReleaseRecord = z.strictObject({
  mode: z.literal("release"),
  version: z.string(),
  platform: z.enum(["mac", "win", "linux"]),
  arch: z.enum(["x64", "arm64"]),
  fusesVerified: z.literal(true),
  artifacts: z.record(z.string().regex(/^[A-Za-z0-9._-]+$/), z.string().regex(/^[a-f0-9]{64}$/)),
});

async function sha256(file: string, signal = AbortSignal.timeout(10 * 60_000)) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest("hex");
}

/** Written only after the final fuse read and all installer creation have succeeded. */
export async function writeReleaseRecord(
  directory: string,
  target: { version: string; platform: "mac" | "win" | "linux"; arch: "x64" | "arm64" },
  files: readonly string[],
) {
  const artifacts: Record<string, string> = {};
  for (const file of files) {
    if (!(await stat(file)).isFile()) continue;
    artifacts[basename(file)] = await sha256(file);
  }
  const record = ReleaseRecord.parse({
    ...target,
    mode: "release",
    fusesVerified: true,
    artifacts,
  });
  await writeFile(join(directory, recordName), `${JSON.stringify(record, null, 2)}\n`);
}

/** Publication cannot accept legacy/test output, or an artifact replaced after verification. */
export async function assertReleaseArtifact(file: string, directory: string, version: string) {
  const record = ReleaseRecord.parse(
    JSON.parse(await readFile(join(directory, recordName), "utf8")),
  );
  if (
    basename(directory) !== `${record.platform}-${record.arch}` ||
    record.version !== version ||
    record.artifacts[basename(file)] !== (await sha256(file))
  )
    throw new Error(`Artifact has no matching verified release record: ${basename(file)}`);
}
