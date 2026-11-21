import { command, type Fixture, mutate, unknown } from "./types.ts";

// Using always is essential: a default ask can hide a missing safety fact.
export const reviewFixtures: readonly Fixture[] = [
  command("git diff --no-index /outside/secret /work/ref", ["git"], {
    reads: ["/work", "/outside/secret", "/work/ref"],
    canRemember: false,
  }),
  command("git diff --no-index /work/ref /outside/secret", ["git"], {
    reads: ["/work", "/work/ref", "/outside/secret"],
    canRemember: false,
  }),
  command("git diff --no-index /work/a /work/b", ["git"], {
    reads: ["/work", "/work/a", "/work/b"],
    decision: "allow",
  }),
  mutate("git log --output=/outside/log", "git", ["/outside/log"], {
    reads: ["/work"],
    decision: "deny",
  }),
  mutate("git log --output /outside/log", "git", ["/outside/log"], {
    reads: ["/work"],
    decision: "deny",
  }),
  mutate("git -C /work/ref log --output=/outside/log", "git", ["/outside/log"], {
    reads: ["/work/ref"],
    decision: "deny",
  }),
  unknown("git diff --unrecognized-option", ["git"], { reads: ["/work"] }),
  command("git diff -- /outside/file", ["git"], {
    reads: ["/work", "/outside/file"],
    canRemember: false,
  }),
  command("git -C /work/ref diff -- ../note", ["git"], {
    reads: ["/work/ref", "/work/note"],
    decision: "allow",
  }),
  unknown("find . -exec echo {} \\; -exec sudo ls \\;", ["find", "echo", "sudo"], {
    reads: ["."],
    decision: "deny",
  }),
  mutate("find . -exec echo {} \\; -exec rm /outside/file \\;", "find", ["/outside/file"], {
    programs: ["find", "echo", "rm"],
    reads: ["/work"],
    decision: "deny",
  }),
  mutate("find . -exec echo {} + -exec rm /outside/file +", "find", ["/outside/file"], {
    programs: ["find", "echo", "rm"],
    reads: ["/work"],
    decision: "deny",
  }),
  unknown("find . -execdir echo {} \\; -okdir sudo ls \\;", ["find", "echo", "sudo"], {
    reads: ["."],
    decision: "deny",
  }),
  mutate("find /outside -exec rm {} \\;", "find", ["/outside"], {
    programs: ["find", "rm"],
    reads: ["/outside"],
    decision: "deny",
  }),
  unknown("find . -unrecognized-option", ["find"], { reads: ["/work"] }),
  command("find . -newer /outside/file", ["find"], {
    reads: ["/work", "/outside/file"],
    canRemember: false,
  }),
  unknown("date -us 2030-01-01", ["date"]),
  unknown("date -uZ +%F", ["date"]),
  command("date -u +%F", ["date"], { decision: "allow" }),
  mutate("file -cC -m /work/magic", "file", ["/work"], { reads: ["/work/magic"] }),
  mutate("file -cCm/work/magic", "file", ["/work"], { reads: ["/work/magic"] }),
  command("file -bc -m/work/magic /work/data", ["file"], {
    reads: ["/work/data", "/work/magic"],
    decision: "allow",
  }),
  unknown("file --unrecognized-option /work/data", ["file"], { reads: ["/work/data"] }),
  mutate("dd if=/dev/zero of=/outside/disk", "dd", ["/outside/disk"], {
    reads: ["/dev/zero"],
    decision: "deny",
  }),
  mutate("dd if=/outside/source of=/work/copied", "dd", ["/work/copied"], {
    reads: ["/outside/source"],
  }),
  mutate("dd if=/work/source of=/work/copied", "dd", ["/work/copied"], { reads: ["/work/source"] }),
  mutate("dd bs=4k count=3 of=/outside/disk", "dd", ["/outside/disk"], { decision: "deny" }),
  mutate("cp -t /outside /work/src", "cp", ["/outside"], {
    reads: ["/work/src"],
    decision: "deny",
  }),
  mutate("cp -t/outside /work/src", "cp", ["/outside"], { reads: ["/work/src"], decision: "deny" }),
  mutate("install -t /outside /work/src", "install", ["/outside"], {
    reads: ["/work/src"],
    decision: "deny",
  }),
  mutate("install --target-directory=/outside /work/src", "install", ["/outside"], {
    reads: ["/work/src"],
    decision: "deny",
  }),
  mutate("tar -C/outside -xf/work/archive.tar", "tar", ["/outside"], {
    reads: ["/work/archive.tar"],
    decision: "deny",
  }),
  mutate("tar --directory=/outside --extract --file=/work/archive.tar", "tar", ["/outside"], {
    reads: ["/work/archive.tar"],
    decision: "deny",
  }),
  mutate("tar -C/outside -cf /work/archive.tar note", "tar", ["/work/archive.tar"], {
    reads: ["/outside/note"],
  }),
  mutate("rsync -av /work/src /outside/dest", "rsync", ["/outside/dest"], {
    reads: ["/work/src"],
    decision: "deny",
  }),
  mutate(
    "rsync --log-file=/outside/log /work/src /work/dest",
    "rsync",
    ["/work/dest", "/outside/log"],
    { reads: ["/work/src"], decision: "deny" },
  ),
  unknown("rsync -av /work/src example.com:dest", ["rsync"], {
    reads: ["/work/src"],
    network: true,
    domains: ["example.com"],
  }),
  mutate(
    "rsync --temp-dir=/outside/tmp /work/src /work/dest",
    "rsync",
    ["/work/dest", "/outside/tmp"],
    { reads: ["/work/src"], decision: "deny" },
  ),
  mutate("install -dt/outside /work/new", "install", ["/outside", "/work/new"], {
    decision: "deny",
  }),
].map((fixture): Fixture => ({ ...fixture, runLevel: "always" }));
