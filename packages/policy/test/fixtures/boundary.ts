import type { Workplaces } from "@pibot/protocol-base";
import { command, type Fixture, unknown } from "./types.ts";

const folderId = "00000000-0000-4000-8000-000000000003";
const workplace: Workplaces = {
  home: "/work",
  folders: [{ id: folderId, name: "Other", path: "/other" }],
  currentId: "home",
};
const cases: Fixture[] = [];
// A known cross-root operation is evaluated at the current level, without generating a grant.
for (const [text, programs, reads, writes] of [
  ["cat /other/report.txt", ["cat"], ["/other/report.txt"], []],
  ["echo hello > /other/report.txt", ["echo"], [], ["/other/report.txt"]],
  [
    "cat /work/report.txt /other/report.txt",
    ["cat"],
    ["/work/report.txt", "/other/report.txt"],
    [],
  ],
  ["cat /other/report.txt > /work/copy.txt", ["cat"], ["/other/report.txt"], ["/work/copy.txt"]],
  ["cat /work/linked-other/report.txt", ["cat"], ["/other/report.txt"], []],
  ["echo hello > /work/linked-other/report.txt", ["echo"], [], ["/other/report.txt"]],
] as const) {
  for (const level of ["ask", "always", "never"] as const)
    cases.push({
      ...command(text, [...programs], {
        reads: [...reads],
        writes: [...writes],
        readonly: writes.length === 0,
        decision: level === "ask" ? "ask" : level === "always" ? "allow" : "deny",
        reason: `permission_${level}`,
        canRemember: false,
        grantScope: null,
      }),
      name: `${text} [cross-root ${level}]`,
      workplace,
      withGrant: true,
      runLevel: level,
    });
}
for (const [text, program, reads, writes] of [
  ["cat /work/report.txt", "cat", ["/work/report.txt"], []],
  ["echo hello > /work/report.txt", "echo", [], ["/work/report.txt"]],
] as const)
  cases.push({
    ...command(text, [program], {
      reads: [...reads],
      writes: [...writes],
      decision: "allow",
      reason: "grant_matched",
      grantScope: { kind: "programs", programs: [program], root: "/work" },
    }),
    name: `${text} [same-root grant]`,
    workplace,
    withGrant: true,
  });
// Selecting /other's cwd uses its own grant; a /work grant does not transfer across cwd.
for (const grantRoot of ["/work", "/other"])
  cases.push({
    ...command("cat report.txt", ["cat"], {
      reads: ["/other/report.txt"],
      decision: grantRoot === "/other" ? "allow" : "ask",
      reason: grantRoot === "/other" ? "grant_matched" : "permission_ask",
      grantScope: { kind: "programs", programs: ["cat"], root: "/other" },
    }),
    name: `cat report.txt [cwd /other, grant ${grantRoot}]`,
    workplace: { ...workplace, currentId: folderId },
    withGrant: true,
    grantRoot,
  });
const nested: Workplaces = {
  ...workplace,
  folders: [{ id: folderId, name: "Nested", path: "/work/nested" }],
};
cases.push({
  ...command("cat /work/nested/report.txt", ["cat"], {
    reads: ["/work/nested/report.txt"],
    decision: "allow",
    reason: "grant_matched",
    grantScope: { kind: "programs", programs: ["cat"], root: "/work" },
  }),
  name: "cat /work/nested/report.txt [contained grant]",
  workplace: nested,
  withGrant: true,
});
cases.push({
  ...command("cat /work/report.txt", ["cat"], {
    reads: ["/work/report.txt"],
    canRemember: false,
    reason: "permission_ask",
    grantScope: null,
  }),
  name: "cat /work/report.txt [cwd nested, parent access]",
  workplace: { ...nested, currentId: folderId },
  withGrant: true,
  grantRoot: "/work/nested",
});
// The root operand is not proof that descendant symbolic links stay inside that root.
for (const [text, program] of [
  ["rg -L needle /work", "rg"],
  ["rg --follow needle", "rg"],
  ["rg -nL needle /work", "rg"],
  ["rg --follow needle /work", "rg"],
  ["rg -L -e needle /work", "rg"],
  ["grep -R needle /work", "grep"],
  ["grep --dereference-recursive needle", "grep"],
  ["grep -nR needle /work", "grep"],
  ["grep --dereference-recursive needle /work", "grep"],
  ["du -L /work", "du"],
  ["du -sL /work", "du"],
  ["du --dereference /work", "du"],
  ["ls -RL /work", "ls"],
  ["ls -R --dereference /work", "ls"],
  ["find -L /work -name '*.txt'", "find"],
] as const) {
  for (const level of ["ask", "always"] as const)
    cases.push({
      ...unknown(text, [program], {
        reads: ["/work"],
        readonly: false,
        unknownOptions: [],
        reason: "incomplete_analysis",
        grantScope: null,
      }),
      name: `${text} [follow ${level}]`,
      withGrant: true,
      runLevel: level,
    });
}
for (const [text, program] of [
  ["rg needle /work", "rg"],
  ["grep -r needle /work", "grep"],
  ["du -s /work", "du"],
  ["ls -R /work", "ls"],
  ["find /work -name '*.txt'", "find"],
] as const)
  cases.push({
    ...command(text, [program], {
      reads: ["/work"],
      readonly: true,
      unknownOptions: [],
      decision: "allow",
      reason: "grant_matched",
    }),
    name: `${text} [no-follow grant]`,
    withGrant: true,
  });
export const boundaryFixtures: readonly Fixture[] = cases;
