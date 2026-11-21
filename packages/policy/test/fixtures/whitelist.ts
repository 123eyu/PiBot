import { command, type Fixture, mutate, unknown } from "./types.ts";

const externalSearch = (text: string, program: string, reads: string[]) =>
  command(text, [program], { reads, canRemember: false, readonly: false, unknownOptions: [] });
const cases: Fixture[] = [
  externalSearch("grep -nif /outside/patterns /work/data", "grep", [
    "/work/data",
    "/outside/patterns",
  ]),
  externalSearch("grep -nif/outside/patterns /work/data", "grep", [
    "/work/data",
    "/outside/patterns",
  ]),
  externalSearch("grep -nepattern /outside/secret", "grep", ["/outside/secret"]),
  externalSearch("grep -ne pattern /outside/secret", "grep", ["/outside/secret"]),
  externalSearch("grep --regexp=pattern /outside/secret", "grep", ["/outside/secret"]),
  externalSearch("grep --file=/outside/patterns /work/data", "grep", [
    "/work/data",
    "/outside/patterns",
  ]),
  externalSearch("rg -nif /outside/patterns /work/data", "rg", ["/work/data", "/outside/patterns"]),
  externalSearch("rg -nif/outside/patterns /work/data", "rg", ["/work/data", "/outside/patterns"]),
  externalSearch("rg -nepattern /outside/secret", "rg", ["/outside/secret"]),
  externalSearch("rg -ne pattern /outside/secret", "rg", ["/outside/secret"]),
  externalSearch("rg --file=/outside/patterns /work/data", "rg", [
    "/work/data",
    "/outside/patterns",
  ]),
  command("grep -nif /work/patterns /work/data", ["grep"], {
    reads: ["/work/data", "/work/patterns"],
    decision: "allow",
    readonly: true,
    unknownOptions: [],
  }),
  command("grep -nepattern /work/data", ["grep"], {
    reads: ["/work/data"],
    decision: "allow",
    readonly: true,
    unknownOptions: [],
  }),
  command("rg -nif /work/patterns /work/data", ["rg"], {
    reads: ["/work/data", "/work/patterns"],
    decision: "allow",
    readonly: true,
    unknownOptions: [],
  }),
  command("grep -nepattern -- /work/-Z", ["grep"], {
    reads: ["/work/-Z"],
    decision: "allow",
    readonly: true,
    unknownOptions: [],
  }),
  mutate("sed -ni 's/a/b/' /outside/file", "sed", ["/outside/file"], {
    decision: "deny",
    readonly: false,
    unknownOptions: [],
  }),
  mutate("sed -ni.bak 's/a/b/' /outside/file", "sed", ["/outside/file", "/outside/file.bak"], {
    decision: "deny",
  }),
  mutate("sed -n -i -e 's/a/b/' /outside/file", "sed", ["/outside/file"], { decision: "deny" }),
  mutate(
    "sed -n --in-place=.bak --expression='s/a/b/' /outside/file",
    "sed",
    ["/outside/file", "/outside/file.bak"],
    { decision: "deny" },
  ),
  mutate("sed -ni 's/a/b/' /work/file", "sed", ["/work/file"], {
    readonly: false,
    unknownOptions: [],
  }),
  mutate("sed '-ni/outside/*' 's/a/b/' /work/file", "sed", ["/work/file", "/outside/work/file"], {
    decision: "deny",
  }),
  {
    ...mutate("sed -ni '' -e 's/a/b/' /outside/file", "sed", ["/outside/file"], {
      decision: "deny",
      readonly: false,
    }),
    platform: "darwin",
  },
  {
    ...mutate(
      "sed -ni.bak -e 's/a/b/' /outside/file",
      "sed",
      ["/outside/file", "/outside/file.bak"],
      { decision: "deny" },
    ),
    platform: "darwin",
  },
  {
    ...mutate(
      "sed -n --in-place=.bak -e 's/a/b/' /outside/file",
      "sed",
      ["/outside/file", "/outside/file.bak"],
      { decision: "deny", reads: ["/outside/file"], unknownOptions: ["--in-place=.bak"] },
    ),
    platform: "darwin",
  },
];
// Exercise unknowns for every readonly program and every modeled write-argument program.
for (const [program, args, reads, writes] of [
  ["ls", "/work/data", ["/work/data"], []],
  ["cat", "/work/data", ["/work/data"], []],
  ["head", "/work/data", ["/work/data"], []],
  ["tail", "/work/data", ["/work/data"], []],
  ["wc", "/work/data", ["/work/data"], []],
  ["grep", "pattern /work/data", ["/work/data"], []],
  ["rg", "pattern /work/data", ["/work/data"], []],
  ["find", "/work/data", ["/work/data"], []],
  ["file", "/work/data", ["/work/data"], []],
  ["stat", "/work/data", ["/work/data"], []],
  ["du", "/work/data", ["/work/data"], []],
  ["df", "/work/data", ["/work/data"], []],
  ["which", "node", [], []],
  ["echo", "hello", [], []],
  ["pwd", "", [], []],
  ["date", "+%F", [], []],
  ["cp", "/work/a /work/b", ["/work/a"], ["/work/b"]],
  ["mv", "/work/a /work/b", ["/work/a"], ["/work/a", "/work/b"]],
  ["install", "/work/a /work/b", ["/work/a"], ["/work/b"]],
  ["rm", "/work/data", [], ["/work/data"]],
  ["rmdir", "/work/data", [], ["/work/data"]],
  ["unlink", "/work/data", [], ["/work/data"]],
  ["mkdir", "/work/data", [], ["/work/data"]],
  ["touch", "/work/data", [], ["/work/data"]],
  ["tee", "/work/data", [], ["/work/data"]],
  ["truncate", "/work/data", [], ["/work/data"]],
  ["chmod", "600 /work/data", [], ["/work/data"]],
  ["chown", "user /work/data", [], ["/work/data"]],
  ["chgrp", "user /work/data", [], ["/work/data"]],
  ["sed", "-e 's/a/b/' /work/data", ["/work/data"], []],
  ["tar", "-tf /work/a.tar", ["/work/a.tar"], []],
  ["rsync", "/work/a /work/b", ["/work/a"], ["/work/b"]],
] as const)
  cases.push(
    unknown(`${program} ${args} --pibot-unknown`.trim(), [program], {
      reads: [...reads],
      writes: [...writes],
      readonly: false,
      unknownOptions: ["--pibot-unknown"],
    }),
  );
for (const subcommand of [
  "status",
  "log",
  "diff",
  "show",
  "push",
  "fetch",
  "pull",
  "clone",
  "clean",
  "reset",
  "config",
  "add",
  "commit",
]) {
  const readOnly = ["status", "log", "diff", "show"].includes(subcommand);
  cases.push(
    unknown(`git ${subcommand} --pibot-unknown`, ["git"], {
      reads: ["/work"],
      writes: readOnly ? [] : ["/work"],
      network: ["push", "fetch", "pull", "clone"].includes(subcommand),
      readonly: false,
      unknownOptions: ["--pibot-unknown"],
    }),
  );
}
cases.push(
  unknown("grep -nQe pattern /work/data", ["grep"], {
    reads: ["/work/data"],
    readonly: false,
    unknownOptions: ["-Q"],
  }),
  unknown("rg -nQe pattern /work/data", ["rg"], {
    reads: ["/work/data"],
    readonly: false,
    unknownOptions: ["-Q"],
  }),
  unknown("dd if=/work/a of=/work/b pibot-unknown=value", ["dd"], {
    reads: ["/work/a"],
    writes: ["/work/b"],
    unknownOptions: ["pibot-unknown"],
  }),
  unknown("git status -n", ["git"], { reads: ["/work"], unknownOptions: ["-n"] }),
);
for (const wrapper of ["env", "time", "xargs", "nohup", "nice", "timeout", "command", "builtin"]) {
  cases.push(
    unknown(
      `${wrapper} --pibot-unknown ${wrapper === "timeout" ? "5 " : ""}ls /work/data`,
      ["ls"],
      { reads: ["/work/data"], unknownOptions: ["--pibot-unknown"], readonly: false },
    ),
  );
}
cases.push(
  unknown("time -po/outside/log ls /work/data", ["ls"], {
    reads: ["/work/data"],
    writes: ["/outside/log"],
    decision: "deny",
    unknownOptions: [],
  }),
);
cases.push(
  unknown("cat -AnZ /work/data", ["cat"], {
    reads: ["/work/data"],
    unknownOptions: ["-Z"],
    readonly: false,
  }),
  unknown("pwd -LZ", ["pwd"], { unknownOptions: ["-Z"], readonly: false }),
  unknown("cp -avQ /work/a /work/b", ["cp"], {
    reads: ["/work/a"],
    writes: ["/work/b"],
    unknownOptions: ["-Q"],
    readonly: false,
  }),
  unknown("sed -nQi -e 's/a/b/' /outside/file", ["sed"], {
    writes: ["/outside/file"],
    decision: "deny",
    unknownOptions: ["-Q"],
    readonly: false,
  }),
  unknown("git diff -pQ", ["git"], { reads: ["/work"], unknownOptions: ["-Q"], readonly: false }),
  unknown("toString", ["toString"], { unknownOptions: [], readonly: false }),
);
cases.push(
  mutate("tar cfv /outside/archive.tar /work/data", "tar", ["/outside/archive.tar"], {
    reads: ["/work/data"],
    decision: "deny",
    unknownOptions: [],
  }),
  unknown("tar cvQf /work/archive.tar /work/data", ["tar"], {
    reads: ["/work/data"],
    writes: ["/work/archive.tar"],
    unknownOptions: ["-Q"],
    readonly: false,
  }),
);
export const whitelistFixtures: readonly Fixture[] = cases.map((fixture) => ({
  ...fixture,
  runLevel: "always",
}));
// Even an already remembered exact program/root set cannot bypass unknowns or external reads.
export const whitelistGrantFixtures: readonly Fixture[] = [
  cases[0],
  cases[2],
  cases[6],
  ...cases.filter((fixture) => fixture.expected.unknownOptions?.length),
]
  .filter((fixture): fixture is Fixture => !!fixture)
  .map((fixture) => ({
    ...fixture,
    name: `${fixture.name} [existing grant]`,
    runLevel: "ask",
    withGrant: true,
  }));
