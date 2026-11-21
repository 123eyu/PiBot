import assert from "node:assert/strict";
import { closeSync, openSync, readSync } from "node:fs";
import type { PackageArch } from "./package-options.ts";

/** Inspect target headers without executing a foreign binary on the build host. */
export function verifyTargetBinary(file: string, platform: string, arch: PackageArch) {
  const fd = openSync(file, "r");
  try {
    const header = Buffer.alloc(64);
    assert.equal(readSync(fd, header, 0, 64, 0), 64, `Truncated executable: ${file}`);
    if (platform === "darwin") {
      const cpu = arch === "x64" ? 0x01000007 : 0x0100000c;
      const magic = header.readUInt32BE(0);
      if (magic === 0xcafebabe || magic === 0xcafebabf) {
        // Some upstream N-API prebuilds are universal even in architecture-named packages.
        const count = header.readUInt32BE(4),
          stride = magic === 0xcafebabf ? 32 : 20;
        assert(count > 0 && count <= 32, "Invalid universal Mach-O architecture count");
        const table = Buffer.alloc(count * stride);
        assert.equal(
          readSync(fd, table, 0, table.length, 8),
          table.length,
          "Truncated Mach-O table",
        );
        assert(
          Array.from({ length: count }, (_, index) => table.readUInt32BE(index * stride)).includes(
            cpu,
          ),
          `Missing target Mach-O CPU: ${file}`,
        );
      } else {
        assert.equal(header.readUInt32LE(0), 0xfeedfacf, `Expected Mach-O: ${file}`);
        assert.equal(header.readUInt32LE(4), cpu, `Wrong Mach-O CPU: ${file}`);
      }
    } else if (platform === "linux") {
      assert.equal(header.subarray(0, 4).toString("hex"), "7f454c46", `Expected ELF: ${file}`);
      assert.equal(header[4], 2, "Expected 64-bit ELF");
      assert.equal(header[5], 1, "Expected little-endian ELF");
      assert.equal(header.readUInt16LE(18), arch === "x64" ? 62 : 183, `Wrong ELF CPU: ${file}`);
    } else {
      assert.equal(header.subarray(0, 2).toString(), "MZ", `Expected PE: ${file}`);
      const offset = header.readUInt32LE(60);
      assert(offset >= 64 && offset < 1024 * 1024, "Invalid PE header offset");
      const pe = Buffer.alloc(6);
      assert.equal(readSync(fd, pe, 0, 6, offset), 6, "Truncated PE header");
      assert.equal(pe.readUInt32LE(0), 0x4550, "Invalid PE signature");
      assert.equal(pe.readUInt16LE(4), arch === "x64" ? 0x8664 : 0xaa64, `Wrong PE CPU: ${file}`);
    }
  } finally {
    closeSync(fd);
  }
}
