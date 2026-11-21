import { lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Tracks explicit Node escapes, not OS containment of arbitrary native daemon descendants. */
export async function packageProcessGuard(lock: string, env: NodeJS.ProcessEnv) {
  const marker = join(lock, "node-escape.json");
  const preload = join(lock, "package-guard.cjs");
  const option = `--require=${JSON.stringify(preload)}`;
  const script = `
const cp = require('node:child_process');
const fs = require('node:fs');
const option = ${JSON.stringify(option)};
function unknown() {
  try { fs.writeFileSync(${JSON.stringify(marker)}, '{"reason":"package_node_escape_unconfirmed"}\\n', {flag:'wx', mode:0o600}); }
  catch (error) { if(error.code !== 'EEXIST') process.exit(78); }
}
const custom = require('node:util').promisify.custom;
function check(args) {
  for (const value of args) {
    if (!value || Array.isArray(value) || typeof value !== 'object') continue;
    if (value.detached === true || (value.env && !String(value.env.NODE_OPTIONS || '').includes(option))) unknown();
  }
}
for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) {
  const original = cp[name];
  const wrapped = function(...args) {
    check(args);
    return Reflect.apply(original, this, args);
  };
  const descriptors = Object.getOwnPropertyDescriptors(original);
  const promised = descriptors[custom];
  delete descriptors[custom];
  Object.defineProperties(wrapped, descriptors);
  // Node's custom Promise includes .child; keep it while guarding the custom entry too.
  if (promised) Object.defineProperty(wrapped, custom, {
    ...promised,
    value: function(...args) {
      check(args);
      return Reflect.apply(original[custom], this, args);
    }
  });
  cp[name] = wrapped;
}
require('node:module').syncBuiltinESMExports();
`;
  await writeFile(preload, script, { flag: "wx", mode: 0o600 });
  return {
    env: { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} ${option}`.trim() },
    async escaped() {
      try {
        await lstat(marker);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
  };
}
