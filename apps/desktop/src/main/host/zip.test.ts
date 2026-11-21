import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createZip } from "./zip.ts";

describe("createZip", () => {
  it.skipIf(process.platform === "win32")(
    "produces an archive that a standard unzip tool can read back",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "pibot-zip-"));
      try {
        const zip = join(dir, "out.zip");
        const entries = [
          {
            name: "logs/2026-10-09.log",
            data: Buffer.from('{"level":"info"}\n'),
            modified: new Date(),
          },
          // Real log names are ASCII dates; non-ASCII content must survive byte-for-byte.
          { name: "logs/2026-10-08.log", data: Buffer.from("第二个文件\n"), modified: new Date() },
        ];
        writeFileSync(zip, createZip(entries));
        const listing = execFileSync("unzip", ["-l", zip]).toString();
        expect(listing).toContain("logs/2026-10-09.log");
        execFileSync("unzip", ["-q", zip, "-d", join(dir, "x")]);
        expect(readFileSync(join(dir, "x", "logs", "2026-10-09.log"), "utf8")).toBe(
          '{"level":"info"}\n',
        );
        expect(readFileSync(join(dir, "x", "logs", "2026-10-08.log"), "utf8")).toBe("第二个文件\n");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("writes a valid empty archive", () => {
    expect(createZip([]).readUInt32LE(0)).toBe(0x06054b50);
  });
});
