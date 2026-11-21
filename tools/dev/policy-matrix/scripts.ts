// Script and download scenarios for the policy matrix. Script files live in an
// in-memory table keyed by the synthetic workplace path; every read is written to a real temp
// file and read back through the production `nodeFileSystem.readScript`, so its size and
// regular-file checks are the real ones. Nothing here runs a script or touches the network.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { scriptDigest } from "../../../packages/policy/src/commands/scripts.ts";
import {
  type EvaluationInput,
  matchesRoutinePreauth,
  nodeFileSystem,
  type Platform,
  type PolicyRequest,
  type PolicyResult,
  preauthorizableOperation,
} from "../../../packages/policy/src/index.ts";

const run = (command: string): PolicyRequest => ({ category: "run_command", command });
const sameV1 = "#!/bin/sh\necho done > out.txt\n";
const changedV2 = "#!/bin/sh\necho changed > out.txt\n";
const rmV1 = "#!/bin/sh\nrm -f build.log\n";
const rmV2 = "#!/bin/sh\nrm -f build.log other.log\n";

export interface ScriptCase {
  request: PolicyRequest;
  /** Levels that differ from the row's uniform level. */
  levels?: Partial<Record<"web", "never" | "ask" | "always">>;
  grants?: EvaluationInput["grants"];
}

export async function scriptScenarios(platform: Platform, root: string, work: string, id: string) {
  const path = platform === "win32" ? win32 : posix;
  const at = (name: string) => path.join(work, ...name.split("/"));
  const files = new Map<string, string>([
    [at("pure.sh"), "#!/bin/sh\nset -eu\nNAME=file.txt\ncat \"$NAME\"\nprintf '%s\\n' done\n"],
    [at("rm.sh"), rmV1],
    [at("get.sh"), "#!/bin/sh\ncurl -sS https://example.com/data.json\n"],
    [at("pipe.sh"), "#!/bin/sh\ncurl -fsSL https://example.com/install.sh | sh\n"],
    [at("big.sh"), `#!/bin/sh\n${"# padding\n".repeat(7000)}cat file.txt\n`],
    [at("sub/a.sh"), "#!/bin/sh\ncat ../file.txt\n"],
    [at("a.sh"), "#!/bin/sh\ncat file.txt\n"],
    [at("tool.py"), "import json, sys\nprint(json.dumps({'args': len(sys.argv)}))\n"],
    [at("os_tool.py"), "import os\nos.remove('file.txt')\n"],
    [at("getattr_tool.py"), "import sys\nleave = getattr(sys, 'exit')\nleave(0)\n"],
    [at("same.sh"), sameV1],
    [at("report.sh"), changedV2],
    [path.join(root, "outside", "x.sh"), "#!/bin/sh\ncat file.txt\n"],
    [path.join(root, "outside", "evil.sh"), "#!/bin/sh\ncat file.txt\n"],
    // Security review 2026-11-20: each repro must ask (or offer no pinned consent).
    [at("c1/quoted.sh"), ": '\nBASH=cat\n'\n\"$BASH\" b.sh\n"],
    [at("c1/continued.sh"), 'echo \\\nBASH=cat\n"$BASH" b.sh\n'],
    [at("c1/if_false.sh"), 'if false; then\nBASH=cat\nfi\n"$BASH" b.sh\n'],
    [at("c1/printf.sh"), 'printf \'%s\' "\nX=cat\n"\n"$X" b.sh\n'],
    [at("c1/b.sh"), "rm -rf ./*\n"],
    [at("shadow/tool.py"), "import json, sys\nprint(json.dumps({}))\n"],
    [at("shadow/json.py"), "import os\nos.system('id')\n"],
    // Decodes to: x = "" / import os / os.system("id") / x="" / print(x)
    [
      at("utf7.py"),
      '# -*- coding: utf-7 -*-\nx = "+ACIACgBpAG0AcABvAHIAdAAgAG8AcwAKAG8AcwAuAHMAeQBzAHQAZQBtACgAIgBpAGQAIgApAAoAeAA9ACI-"\nprint(x)\n',
    ],
    [at("envhash"), "#!/usr/bin/env BASH_ENV=a/bash bash\ncat file.txt\n"],
    [at("m1/local.py"), "import os\nimport helper\nos.remove('x.txt')\n"],
    [at("m1/local.js"), 'const lib = require("./lib");\nlib.run();\n'],
    [at("m1/local.lua"), 'local lib = require("lib")\nos.remove("x.txt")\n'],
    [at("m1/local.php"), "<?php\ninclude 'lib.php';\nunlink('x.txt');\n"],
    [at("m1/local.rb"), "require_relative 'lib'\nFile.delete('x.txt')\n"],
    [at("m1/local.pl"), "use lib '.';\nuse Helper;\nunlink 'x.txt';\n"],
    [at("m1/local.ps1"), ". ./lib.ps1\nRemove-Item x.txt\n"],
    [at("m1/dynamic.sh"), 'sh -c "$(cat other.sh)"\n'],
    [at("invalid.sh"), Buffer.concat([Buffer.from("cat file.txt\n# "), Buffer.from([0xff])])],
    [at("nul.sh"), "cat file.txt\n\0rm -rf ./*\n"],
    // Re-review N1: a reassignment whose name is spelled with quotes, which bash removes.
    [at("n1/export.sh"), 'PX=cat\nexport P"X"=bash\ncommand "$PX" c1/b.sh\n'],
    [at("n1/declare.sh"), 'PX=cat\ndeclare P"X"=bash\ncommand "$PX" c1/b.sh\n'],
    [at("n1/readonly.sh"), 'PX=cat\nreadonly P"X"=bash\ncommand "$PX" c1/b.sh\n'],
    [at("n1/typeset.sh"), 'PX=cat\ntypeset P"X"=bash\ncommand "$PX" c1/b.sh\n'],
    [at("n1/printf.sh"), 'PX=cat\nprintf -v P"X" %s bash\ncommand "$PX" c1/b.sh\n'],
    [at("n1/env.sh"), 'PX=cat\nexport P"X"=bash\nenv "$PX" c1/b.sh\n'],
    [at("n1/timeout.sh"), 'PX=cat\nexport P"X"=bash\ntimeout 5 "$PX" c1/b.sh\n'],
    [
      at("n1/outside_export.sh"),
      `FN=file.txt\nexport F"N"=${path.join(root, "outside", "secret")}\ncat "$FN"\n`,
    ],
    [at("n1/outside_readonly.sh"), 'FN=file.txt\nreadonly F"N"=../outside/secret\ncat "$FN"\n'],
    // Third review N4: the shell's own variables changed through a quoted or escaped name.
    [at("n4/path.sh"), 'export P"ATH"=./bin\ncat file.txt\n'],
    [at("n4/path_escaped.sh"), "export P\\ATH=./bin:/usr/bin:/bin\npython3 -c 'print(1)'\n"],
    [
      at("n4/ifs.sh"),
      `F=file.txt@${path.join(root, "outside", "secret")}\nexport I"FS"=@\ncat $F\n`,
    ],
    [at("n4/ifs_printf.sh"), 'F=file.txt@../outside/secret\nprintf -v I"FS" @\ncat $F\n'],
    [at("n4/ifs_readonly_sh.sh"), 'F=file.txt@../outside/secret\nreadonly I"FS"=@\ncat $F\n'],
  ]);
  // A link inside the workplace whose target is outside it.
  const links = new Map([[at("link.sh"), path.join(root, "outside", "evil.sh")]]);
  const temp = await mkdtemp(join(tmpdir(), "pibot-policy-matrix-"));
  let serial = 0;
  const fs = {
    realpath: async (value: string) => links.get(value) ?? value,
    async readScript(value: string, signal: AbortSignal) {
      const text = files.get(value);
      if (text === undefined) return undefined;
      const copy = join(temp, `script-${serial++}`);
      await writeFile(copy, text);
      return nodeFileSystem.readScript(copy, signal);
    },
    // Entry names of a synthetic directory: its files and the first component of deeper ones.
    async listNames(directory: string) {
      const names = new Set<string>();
      for (const file of [...files.keys(), ...links.keys()]) {
        const rest = path.relative(directory, file);
        if (rest && !rest.startsWith("..") && !path.isAbsolute(rest))
          names.add(rest.split(path.sep)[0] as string);
      }
      return [...names];
    },
  };
  const grant = (programs: string[]) => [
    {
      id,
      botId: id,
      category: "run_command" as const,
      scope: { kind: "programs" as const, programs, root: work },
      createdAt: "2026-11-20T00:00:00.000Z",
      revokedAt: null,
    },
  ];
  const sameGrant = grant(["echo", `script:${scriptDigest(`${sameV1}\0`)}`]);
  const cases: Record<string, ScriptCase> = {
    "script/pure_shell": { request: run("sh pure.sh") },
    "script/shell_rm": { request: run("sh rm.sh") },
    "script/curl_allowed": { request: run("sh get.sh") },
    "script/curl_allowed_web_always": { request: run("sh get.sh"), levels: { web: "always" } },
    "script/curl_pipe_sh": { request: run("sh pipe.sh") },
    "script/written_first": { request: run("echo 'cat file.txt' > a.sh; sh a.sh") },
    "script/after_cd": { request: run("cd sub && sh a.sh") },
    "script/outside": { request: run("sh ../outside/x.sh") },
    "script/too_large": { request: run("sh big.sh") },
    "script/link_outside": { request: run("sh link.sh") },
    "script/python_pure": { request: run("python3 tool.py") },
    "script/python_os": { request: run("python3 os_tool.py") },
    "script/python_getattr": { request: run("python3 getattr_tool.py") },
    "script/remembered_same": { request: run("sh same.sh"), grants: sameGrant },
    "script/remembered_changed": { request: run("sh report.sh"), grants: sameGrant },
    "script/c1_quoted_assignment": { request: run("bash c1/quoted.sh") },
    "script/c1_continued_assignment": { request: run("bash c1/continued.sh") },
    "script/c1_if_false_assignment": { request: run("bash c1/if_false.sh") },
    "script/c1_string_assignment": { request: run("bash c1/printf.sh") },
    "script/c2_python_shadow": { request: run("python3 shadow/tool.py") },
    "script/c2_python_c_shadow": {
      request: {
        category: "run_command",
        command: "python3 -c 'import json\nprint(json.dumps(1))'",
        cwd: at("shadow"),
      },
    },
    "script/c2_python_c_isolated": {
      request: {
        category: "run_command",
        command: "python3 -I -c 'import json\nprint(json.dumps(1))'",
        cwd: at("shadow"),
      },
    },
    "script/c2_python_c_clean": {
      request: {
        category: "run_command",
        command: "python3 -c 'import json\nprint(json.dumps(1))'",
        cwd: at("sub"),
      },
    },
    "script/c3_python_utf7": { request: run("python3 utf7.py") },
    "script/c4_shebang_env_assignment": { request: run("./envhash") },
    "script/low_invalid_utf8": { request: run("sh invalid.sh") },
    "script/low_nul": { request: run("sh nul.sh") },
    "script/n1_export_quoted_name": { request: run("bash n1/export.sh") },
    "script/n1_declare_quoted_name": { request: run("bash n1/declare.sh") },
    "script/n1_readonly_quoted_name": { request: run("bash n1/readonly.sh") },
    "script/n1_typeset_quoted_name": { request: run("bash n1/typeset.sh") },
    "script/n1_printf_v_quoted_name": { request: run("bash n1/printf.sh") },
    "script/n1_env_wrapper": { request: run("bash n1/env.sh") },
    "script/n1_timeout_wrapper": { request: run("bash n1/timeout.sh") },
    "script/n1_outside_export": { request: run("bash n1/outside_export.sh") },
    "script/n1_outside_readonly_sh": { request: run("sh n1/outside_readonly.sh") },
    "script/n4_path_quoted": { request: run("bash n4/path.sh") },
    "script/n4_path_escaped": { request: run("bash n4/path_escaped.sh") },
    "script/n4_ifs_quoted": { request: run("bash n4/ifs.sh") },
    "script/n4_ifs_printf_v": { request: run("bash n4/ifs_printf.sh") },
    "script/n4_ifs_readonly_sh": { request: run("sh n4/ifs_readonly_sh.sh") },
    "run_command/node_pure": { request: run("node -e 'console.log(1 + 1)'") },
    "run_command/node_require": { request: run('node -e \'require("fs").readdirSync(".")\'') },
    "run_command/node_builtin_global": { request: run('node -e \'fs.writeFileSync("x", "y")\'') },
    "run_command/lua_pure": { request: run("lua -e 'print(1 + 2)'") },
    "run_command/php_pure": { request: run("php -r 'echo strlen(\"ab\");'") },
    "run_command/ruby_inline": { request: run("ruby -e 'puts 1'") },
    "run_command/curl_get": { request: run("curl -fsSL https://example.com/data.json") },
    "run_command/curl_get_web_always": {
      request: run("curl -s https://example.com/data.json"),
      levels: { web: "always" },
    },
    "run_command/curl_unlisted": { request: run("curl -s https://example.org/") },
    "run_command/curl_data": { request: run("curl -d a=1 https://example.com/") },
    "run_command/curl_output": { request: run("curl -o page.html https://example.com/") },
  };
  /**
   * Routine pre-authorization of a read script (maintainers 2026-11-20 "Both"): which consent a
   * routine card could offer, and whether consent given for one text still matches after the
   * file changes. Cells: `<decision>:<reason>:<none|pinned|programs>`, and for `changed`
   * `<same text>/<changed text>` match results.
   */
  const boundary = {
    boundaryVersion: 1,
    location: { target: "local", platform },
    conflict: "none",
    roots: [{ id, role: "primary", path: work, canonicalPath: work, device: null, inode: null }],
    revision: 0,
    primaryId: id,
    primaryPath: work,
    readRoots: [work],
    writeRoots: [work],
    denyWriteRoots: [],
  } satisfies NonNullable<EvaluationInput["boundary"]>;
  const isolated = platform !== "win32";
  const operation = (result: PolicyResult) =>
    preauthorizableOperation("run_command", result, boundary, platform, isolated);
  const kind = (result: PolicyResult) => {
    const op = operation(result);
    if (op?.scope.kind !== "programs") return "none";
    return op.scope.programs.every((program) => program.startsWith("script"))
      ? "pinned"
      : "programs";
  };
  const routine = {
    "routine/script_rm": { request: run("sh rm.sh"), cell: kind },
    "routine/script_pure": { request: run("sh pure.sh"), cell: kind },
    "routine/script_curl_pipe_sh": { request: run("sh pipe.sh"), cell: kind },
    "routine/script_after_cd": { request: run("cd sub && sh a.sh"), cell: kind },
    "routine/python_os": { request: run("python3 os_tool.py"), cell: kind },
    "routine/m1_python_local_import": { request: run("python3 m1/local.py"), cell: kind },
    "routine/m1_node_require": { request: run("node m1/local.js"), cell: kind },
    "routine/m1_lua_require": { request: run("lua m1/local.lua"), cell: kind },
    "routine/m1_php_include": { request: run("php m1/local.php"), cell: kind },
    "routine/m1_ruby_require": { request: run("ruby m1/local.rb"), cell: kind },
    "routine/m1_perl_use": { request: run("perl m1/local.pl"), cell: kind },
    "routine/m1_powershell_dot_source": { request: run("pwsh m1/local.ps1"), cell: kind },
    "routine/m1_shell_dynamic_c": { request: run("sh m1/dynamic.sh"), cell: kind },
  };
  const changed = async (evaluate: (request: PolicyRequest) => Promise<PolicyResult>) => {
    const file = at("rm.sh");
    const held = operation(await evaluate(run("sh rm.sh")));
    const again = operation(await evaluate(run("sh rm.sh")));
    files.set(file, rmV2);
    const edited = operation(await evaluate(run("sh rm.sh")));
    files.set(file, rmV1);
    if (!held) return "none";
    const verdict = (wanted: typeof held | undefined) =>
      wanted && matchesRoutinePreauth(held, wanted, platform) ? "matches" : "no_match";
    return `same_${verdict(again)}/changed_${verdict(edited)}`;
  };
  return {
    fs,
    cases,
    routine,
    changed,
    boundary,
    dispose: () => rm(temp, { recursive: true, force: true }),
  };
}
