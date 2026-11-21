import { join } from "node:path";
import type { DiscoverySourceId } from "@pibot/plugins-contract/full";

export type McpFormat = "claude-json" | "mcp-servers" | "codex-toml" | "opencode";
export interface SourceLayout {
  id: DiscoverySourceId;
  name: string;
  /** The tool counts as installed when this folder exists. */
  base: string;
  skillRoots: string[];
  /** `homeScope`: the project key that means "outside any project" in a per-project file. */
  mcpFiles: { path: string; format: McpFormat; homeScope?: string }[];
  plugins?:
    | { kind: "claude-installed"; file: string }
    | { kind: "cache"; root: string }
    | { kind: "codex"; root: string };
}

/**
 * Where each tool keeps user-level skills, MCP servers and plugins (checked against the tools'
 * own docs on 2026-10-31). `~` is the OS home on
 * every platform (`%USERPROFILE%` on Windows); each tool's own override variable is honoured.
 * Project-level files are not read: they belong to a repository, not to the person.
 *
 * pi: only its skills folder. Its credentials, sessions, settings and MCP file are
 * never read.
 */
export function sourceLayouts(
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): SourceLayout[] {
  const claude = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const codex = env.CODEX_HOME || join(home, ".codex");
  // Not PI_CODING_AGENT_DIR: the desktop points it at Pi Bot's own pi folder before starting the
  // brain, and this read is about the person's own pi skills.
  const pi = join(home, ".pi", "agent");
  const opencode =
    env.OPENCODE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode");
  return [
    {
      id: "claude-code",
      name: "Claude Code",
      base: claude,
      // Skills synced from claude.ai sit two levels down (`skills/synced/<bucket>/<name>`); the
      // scan opens folders without SKILL.md up to two levels deep, which covers them.
      skillRoots: [join(claude, "skills")],
      // CLAUDE_CONFIG_DIR moves `.claude.json` inside it; otherwise it sits in the home folder.
      mcpFiles: [
        {
          path: env.CLAUDE_CONFIG_DIR ? join(claude, ".claude.json") : join(home, ".claude.json"),
          format: "claude-json",
          homeScope: home,
        },
      ],
      plugins: {
        kind: "claude-installed",
        file: join(claude, "plugins", "installed_plugins.json"),
      },
    },
    {
      id: "codex",
      name: "Codex",
      base: codex,
      // `~/.agents/skills` is Codex's documented user folder (Cursor, pi and OpenCode read it
      // too; the scan lists each folder once); `~/.codex/skills` is the older location.
      skillRoots: [join(home, ".agents", "skills"), join(codex, "skills")],
      mcpFiles: [{ path: join(codex, "config.toml"), format: "codex-toml" }],
      // Codex keeps marketplace versions under plugins/cache, while local bundles may be placed
      // directly below plugins. Both are read-only discovery locations; credentials and Codex
      // config remain outside this scan.
      plugins: { kind: "codex", root: join(codex, "plugins") },
    },
    {
      id: "cursor",
      name: "Cursor",
      base: join(home, ".cursor"),
      skillRoots: [join(home, ".cursor", "skills")],
      mcpFiles: [{ path: join(home, ".cursor", "mcp.json"), format: "mcp-servers" }],
    },
    {
      id: "pi",
      name: "pi",
      base: pi,
      skillRoots: [join(pi, "skills")],
      mcpFiles: [],
    },
    {
      id: "opencode",
      name: "OpenCode",
      base: opencode,
      skillRoots: [join(opencode, "skills"), join(opencode, "skill")],
      mcpFiles: [
        { path: join(opencode, "opencode.json"), format: "opencode" },
        { path: join(opencode, "opencode.jsonc"), format: "opencode" },
      ],
    },
  ];
}
