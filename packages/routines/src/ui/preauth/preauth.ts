import type { createTranslator } from "@pibot/i18n";
import {
  credentialSiteLabel,
  type Permissions,
  type RoutinePreauth,
  type RoutinePreauthInput,
  RoutinePreauthInputSchema,
  type Workplaces,
} from "@pibot/protocol";

// Policy names a read script by the digest of its text and, for consent pinned to
// one script, by the file as written; both are scope entries like program names.
const SCRIPT_PROGRAM = /^script:[0-9a-f]{16}$|^script-file:[^\0\r\n]{1,1024}$/;
const pathKey = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
export function containsPath(root: string, path: string) {
  let a = pathKey(root),
    b = pathKey(path);
  if (/^[A-Za-z]:/.test(a) || a.startsWith("//")) {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  if (b.split("/").some((part) => part === "." || part === "..")) return false;
  return b === a || b.startsWith(a === "/" ? a : `${a}/`);
}
export function primaryPath(places: Workplaces) {
  return places.currentId === "home"
    ? places.home
    : places.folders.find((f) => f.id === places.currentId)?.path;
}
/**
 * Every list that shows a preauthorization must use the same words for the same reason.
 * `runner` is not a scope problem: re-picking the folder cannot fix an offline execution target.
 */
export function invalidReasonKey(
  reason: NonNullable<RoutinePreauth["invalidReason"]>,
):
  | "routines.invalidPermission"
  | "routines.invalidScope"
  | "routines.runnerUnavailable"
  | "routines.reauthorizationRequired" {
  if (reason === "validation") return "routines.reauthorizationRequired";
  if (reason === "permission") return "routines.invalidPermission";
  if (reason === "runner") return "routines.runnerUnavailable";
  return "routines.invalidScope";
}
export function preauthIssue(
  op: RoutinePreauthInput,
  permissions?: Permissions,
  places?: Workplaces,
  saved?: RoutinePreauth,
):
  | "routines.invalidPermission"
  | "routines.invalidScope"
  | "routines.runnerUnavailable"
  | "routines.reauthorizationRequired"
  | undefined {
  if (saved?.invalidReason) return invalidReasonKey(saved.invalidReason);
  if (!permissions?.effective || !places || permissions.effective.levels[op.category] === "never")
    return "routines.invalidPermission";
  if (!RoutinePreauthInputSchema.safeParse(op).success) return "routines.invalidScope";
  const primary = primaryPath(places);
  const readonly = [...places.folders.filter((f) => f.id !== places.currentId).map((f) => f.path)];
  const snapshot = saved?.workspaceSnapshot;
  const snapshotPrimary = snapshot?.roots.find((root) => root.id === places.currentId);
  if (
    snapshot &&
    // A routine's folders have no revision of their own; the roots themselves decide.
    (snapshot.conflict !== "none" ||
      snapshot.primaryId !== places.currentId ||
      snapshotPrimary?.path !== primary)
  )
    return "routines.invalidScope";
  if (op.scope.kind === "workplace" || op.scope.kind === "programs") {
    const root = op.scope.root;
    // A saved canonical spelling is a display hint only; execution must recanonicalize the live filesystem.
    const displayRoots = [primary, snapshotPrimary?.canonicalPath].filter(
      (path): path is string => !!path,
    );
    const deniedRoots = [...readonly, ...(snapshot?.denyWriteRoots ?? [])];
    if (
      !primary ||
      !displayRoots.some((path) => containsPath(path, root)) ||
      deniedRoots.some((r) => containsPath(r, root))
    )
      return "routines.invalidScope";
    if (
      op.scope.kind === "programs" &&
      (!permissions.isolation.available ||
        readonly.length > 0 ||
        op.scope.programs.some(
          (p) =>
            !(/^[\w.+-]+$/.test(p) || SCRIPT_PROGRAM.test(p)) ||
            /^(sudo|su|doas|shutdown|reboot|halt|poweroff)$/i.test(p),
        ))
    )
      return "routines.invalidScope";
  }
  if (
    op.scope.kind === "domain" &&
    !permissions.effective.network.allowAll &&
    !permissions.effective.network.domains.includes(op.scope.domain)
  )
    return "routines.invalidPermission";
  // Submitting forms on a site of the allowed list or one of its subdomains.
  if (op.scope.kind === "submit") {
    const domain = op.scope.domain;
    if (
      !permissions.effective.network.allowAll &&
      !permissions.effective.network.domains.some(
        (entry) => domain === entry || domain.endsWith(`.${entry}`),
      )
    )
      return "routines.invalidPermission";
  }
  return undefined;
}
export function operationText(op: RoutinePreauthInput, t?: ReturnType<typeof createTranslator>) {
  const scope = op.scope;
  if (scope.kind === "submit")
    return t ? t("permissions.submitScope", { site: scope.domain }) : scope.domain;
  if (scope.kind === "programs") return `${scope.programs.join(", ")} · ${scope.root}`;
  if (scope.kind === "folder") return scope.path;
  if (scope.kind === "domain") return scope.domain;
  if (scope.kind === "login") return credentialSiteLabel(scope.site);
  if (scope.kind === "paid_image") return `${scope.provider} / ${scope.model}`;
  return scope.kind === "workplace" ? scope.root : "";
}

/** What the user typed for a site ("example.com", "https://www.example.com/a") as its host. */
export function siteInput(value: string) {
  const text = value.trim();
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`).hostname
      .toLowerCase()
      .replace(/\.$/, "");
  } catch {
    return text;
  }
}
