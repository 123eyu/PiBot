import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as ResEdit from "resedit";

/**
 * The SEA executable is Node's own node.exe, so Windows showed "Node.js JavaScript Runtime /
 * Node.js" in the firewall prompt and Task Manager (round-1 VM 2026-11-12). Its version strings
 * and icon become Pi Bot Runner's after the SEA blob is injected and before signing. Every other
 * resource, the NODE_SEA_BLOB included, is carried over unchanged.
 */
export async function brandWindowsExecutable(executable: string, repo: string, version: string) {
  const program = ResEdit.NtExecutable.from(await readFile(executable), { ignoreCert: true });
  const resources = ResEdit.NtExecutableResource.from(program);
  const icon = ResEdit.Data.IconFile.from(
    await readFile(join(repo, "apps", "desktop", "build", "icon.ico")),
  );
  const group = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries)[0];
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    resources.entries,
    group?.id ?? 1,
    group?.lang ?? 1033,
    icon.icons.map((item) => item.data),
  );
  const info = ResEdit.Resource.VersionInfo.fromEntries(resources.entries)[0];
  if (!info) throw new Error("runner_version_info_missing");
  const [major = 0, minor = 0, patch = 0] = version.split(/[.+-]/).map(Number);
  info.setFileVersion(major, minor, patch, 0);
  info.setProductVersion(major, minor, patch, 0);
  for (const language of info.getAllLanguagesForStringValues())
    info.setStringValues(language, {
      CompanyName: "Pi Bot",
      FileDescription: "Pi Bot Runner",
      ProductName: "Pi Bot Runner",
      InternalName: "pibot",
      OriginalFilename: "pibot.exe",
      FileVersion: version,
      ProductVersion: version,
      // Node's licence notice stays with the program (resources/NODE-LICENSE ships beside it).
      LegalCopyright: "Pi Bot. Includes Node.js (MIT licence).",
    });
  info.outputToResourceEntries(resources.entries);
  resources.outputResource(program);
  await writeFile(executable, Buffer.from(program.generate()));
}
