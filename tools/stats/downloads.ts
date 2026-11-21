// Download counts from GitHub Releases' public API. Unauthenticated on purpose: no token is
// read or sent (owner rule: never use a personal GITHUB_TOKEN), so the 60 requests/hour limit applies.
import { parseArgs } from "node:util";

interface Asset {
  name: string;
  download_count: number;
}
interface Release {
  tag_name: string;
  published_at: string | null;
  draft: boolean;
  assets: Asset[];
}

const { values } = parseArgs({ options: { repo: { type: "string" }, json: { type: "boolean" } } });
if (!values.repo || !/^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(values.repo)) {
  console.error("用法：pnpm stats:downloads --repo <owner/name> [--json]");
  process.exit(2);
}

function platformOf(name: string) {
  const lower = name.toLowerCase();
  if (/\.(blockmap|yml|yaml|sha256|sig)$/.test(lower)) return undefined;
  if (lower.endsWith(".apk") || lower.endsWith(".aab")) return "android";
  if (lower.includes("mac") || lower.includes("darwin") || lower.endsWith(".dmg"))
    return lower.includes("arm64") ? "macos-arm64" : "macos-x64";
  if (lower.includes("win") || lower.endsWith(".exe"))
    return lower.includes("arm64") ? "windows-arm64" : "windows-x64";
  if (lower.includes("linux") || /\.(appimage|deb|rpm)$/.test(lower))
    return lower.includes("arm64") ? "linux-arm64" : "linux-x64";
  if (lower.includes("runner")) return "runner";
  return "other";
}

const releases: Release[] = [];
let url: string | undefined = `https://api.github.com/repos/${values.repo}/releases?per_page=100`;
for (let page = 0; url && page < 10; page++) {
  const response: Response = await fetch(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "pibot-stats" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    console.error(
      `GitHub 返回 ${response.status}${response.status === 403 ? "（未登录的接口每小时 60 次，稍后再试）" : ""}`,
    );
    process.exit(1);
  }
  releases.push(...((await response.json()) as Release[]));
  url = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1];
}

const rows = releases
  .filter((release) => !release.draft)
  .map((release) => {
    const byPlatform: Record<string, number> = {};
    for (const asset of release.assets) {
      const platform = platformOf(asset.name);
      if (platform) byPlatform[platform] = (byPlatform[platform] ?? 0) + asset.download_count;
    }
    const total = Object.values(byPlatform).reduce((sum, n) => sum + n, 0);
    return {
      tag: release.tag_name,
      published: release.published_at?.slice(0, 10) ?? "",
      total,
      byPlatform,
    };
  });
if (values.json) console.log(JSON.stringify(rows, null, 2));
else {
  for (const row of rows) {
    const parts = Object.entries(row.byPlatform)
      .sort(([, a], [, b]) => b - a)
      .map(([platform, n]) => `${platform} ${n}`);
    console.log(
      `${row.tag.padEnd(12)} ${row.published}  合计 ${String(row.total).padStart(7)}  ${parts.join(" · ")}`,
    );
  }
  console.log(
    `全部版本合计 ${rows.reduce((sum, row) => sum + row.total, 0)}（不含 .yml / .blockmap 等更新元数据）`,
  );
}
