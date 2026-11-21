import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { type ComputerDriver, launchCommand, runLaunch } from "@pibot/computer";
import { fileIdentityKey } from "@pibot/execution/file-identity";
import type { Logger } from "@pibot/observability";
import {
  type HostParams,
  type HostResults,
  type OfficeFormat,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";
import { type MacOfficeAppQuery, macOfficeApps } from "./mac-office-apps.ts";

const all: OfficeFormat[] = ["docx", "xlsx", "pptx"];
const officeIds: Record<string, OfficeFormat[]> = {
  "com.apple.iwork.pages": ["docx"],
  "com.apple.iwork.numbers": ["xlsx"],
  "com.apple.iwork.keynote": ["pptx"],
  "com.microsoft.word": ["docx"],
  "com.microsoft.excel": ["xlsx"],
  "com.microsoft.powerpoint": ["pptx"],
  "com.kingsoft.wpsoffice.mac": all,
  "org.libreoffice.script": all,
  "winword.exe": ["docx"],
  "excel.exe": ["xlsx"],
  "powerpnt.exe": ["pptx"],
  "wps.exe": ["docx"],
  "et.exe": ["xlsx"],
  "wpp.exe": ["pptx"],
  "soffice.exe": all,
  "libreoffice-startcenter.desktop": all,
  "libreoffice-writer.desktop": ["docx"],
  "libreoffice-calc.desktop": ["xlsx"],
  "libreoffice-impress.desktop": ["pptx"],
  "wps-office-wps.desktop": ["docx"],
  "wps-office-et.desktop": ["xlsx"],
  "wps-office-wpp.desktop": ["pptx"],
};

async function authorizedFile(input: string, roots: string[]) {
  const file = await realpath(input);
  // Bigint stats keep the identity exact on NTFS (see execution core/file-identity.ts).
  const info = await stat(file, { bigint: true });
  if (file !== resolve(input) || !info.isFile())
    throw new RpcError(RpcErrorCodes.attachmentInvalid, "office_file_identity_changed");
  let allowed = false;
  for (const root of roots) {
    const canonical = await realpath(root);
    const path = relative(canonical, file);
    if (
      canonical === resolve(root) &&
      path &&
      path !== ".." &&
      !path.startsWith(`..${sep}`) &&
      !isAbsolute(path)
    )
      allowed = true;
  }
  if (!allowed) throw new RpcError(RpcErrorCodes.attachmentInvalid, "office_file_outside_roots");
  return { file, identity: `${fileIdentityKey(info)}:${info.size}:${info.mtimeNs}` };
}

export function createOfficeHost(options: {
  platform: NodeJS.Platform;
  driver(): Pick<ComputerDriver, "platform" | "installedApps" | "launchPath">;
  logger: Logger;
  blocked?(app: { id: string; name: string }): boolean;
  queryMacApp?: MacOfficeAppQuery;
  launch?: typeof runLaunch;
}) {
  const lifetime = new AbortController();
  const bounded = (signal?: AbortSignal) =>
    AbortSignal.any([lifetime.signal, AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]);
  async function apps(
    params: HostParams["host.officeApps"],
    signal?: AbortSignal,
  ): Promise<HostResults["host.officeApps"]> {
    const active = bounded(signal);
    active.throwIfAborted();
    const found =
      options.platform === "darwin"
        ? {
            apps: await macOfficeApps(
              Object.entries(officeIds)
                .filter(
                  ([id, formats]) => /^(com|org)\./.test(id) && formats.includes(params.format),
                )
                .map(([id]) => id),
              active,
              options.queryMacApp,
            ),
          }
        : await options.driver().installedApps(2_000, active);
    active.throwIfAborted();
    const seen = new Set<string>();
    return {
      apps: found.apps
        .slice(0, 2_000)
        .flatMap((app) => {
          const id = app.id.toLowerCase();
          const formats = Object.hasOwn(officeIds, id) ? officeIds[id] : undefined;
          if (!formats?.includes(params.format) || options.blocked?.(app) || seen.has(id))
            return [];
          seen.add(id);
          return [{ id: app.id, name: (app.name || app.id).slice(0, 200), formats: [...formats] }];
        })
        .slice(0, 100),
      // This reports the OS open entry point, not a verified default file association.
      defaultAvailable: true,
    };
  }
  async function open(params: HostParams["host.officeOpen"], signal?: AbortSignal): Promise<null> {
    const active = bounded(signal);
    active.throwIfAborted();
    if (!isAbsolute(params.file))
      throw new RpcError(RpcErrorCodes.invalidParams, "office_file_not_absolute");
    const identity = await authorizedFile(params.file, params.allowedRoots);
    const file = identity.file;
    const format = extname(file).slice(1).toLowerCase();
    if (format !== "docx" && format !== "xlsx" && format !== "pptx")
      throw new RpcError(RpcErrorCodes.unsupported, "office_format_unsupported");
    const directory = await apps({ format }, active);
    const app = directory.apps.find((app) => app.id === params.appId);
    if (!app) throw new RpcError(RpcErrorCodes.attachmentInvalid, "office_application_unavailable");
    // The macOS path must not even construct a Cua driver when TCC grants are absent.
    const driver = options.platform === "darwin" ? undefined : options.driver();
    const platform = driver?.platform ?? "darwin";
    const executable =
      driver?.platform === "win32" ? await driver.launchPath?.(app.id, active) : undefined;
    const current = await authorizedFile(params.file, params.allowedRoots);
    if (current.identity !== identity.identity)
      throw new RpcError(RpcErrorCodes.attachmentInvalid, "office_file_identity_changed");
    active.throwIfAborted();
    await (options.launch ?? runLaunch)(
      launchCommand(platform, { kind: "file", path: file, app: app.id }, executable),
      active,
    );
    options.logger.info(
      JSON.stringify({
        module: "office-host",
        event: "office.open",
        botId: params.botId,
        appId: app.id,
        format,
      }),
    );
    return null;
  }
  return { apps, open, dispose: () => lifetime.abort() };
}
