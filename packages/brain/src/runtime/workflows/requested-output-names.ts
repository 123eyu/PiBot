// These are naming facts, never paths to open or permission grants. Keep spelling and case.
export function outputBasename(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? "";
}

function filename(value: string): string | undefined {
  if (value.length > 4096 || /[\p{Cc}<>|?*]/u.test(value) || /^[a-z]+:\/\//iu.test(value)) return;
  const name = outputBasename(value.trim());
  if (
    name.length <= 200 &&
    /^[^\s.<>:"/\\|?*\p{Cc}][^<>:"/\\|?*\p{Cc}]*\.[a-z][a-z\d]{0,9}$/iu.test(name)
  )
    return name;
}

const CUES =
  /文件名|命名|名为|叫做|保存为|另存为|输出为|写成|汇总成|整理成|转换成|转成|写到|交付|生成|创建|制作|输出|保存|导出|写入|产出|请写|要|读取|读入|阅读|查看|查阅|运行|执行|分析|根据|参考|参照|模板|格式|使用|输入|附件|来自|基于|访问|打开|查找|搜索|把|将|按|\b(?:file\s*name|named|called|save\s+as|write|create|generate|produce|deliver|output|export|save|read|run|execute|analy[sz]e|using|from|input|attachment|visit|open|find|search|template|format|according to)\b/giu;
const INPUT =
  /^(?:读取|读入|阅读|查看|查阅|运行|执行|分析|根据|参考|参照|模板|格式|使用|输入|附件|来自|基于|访问|打开|查找|搜索|把|将|按|read|run|execute|analy[sz]e|using|from|input|attachment|visit|open|find|search|template|format|according to)$/iu;
const NAMING =
  /^(?:文件名|命名|名为|叫做|保存为|另存为|输出为|写成|file\s*name|named|called|save\s+as)$/iu;
const NAME_LIKE = /[\p{L}\p{N}_./\\:-]+\.[a-z][a-z\d]{0,9}(?![\p{L}\p{N}_.])/giu;

/** Only the caller's current request belongs here, never history, method bodies or model text. */
export function requestedOutputNames(request: string): string[] {
  const text = request.slice(0, 80_000);
  const candidates: { name: string; naming: boolean; end: number }[] = [];
  // Quoted names may contain spaces. Bare names deliberately stop at prose punctuation.
  const tokens =
    /`([^`\n]+)`|「([^」\n]+)」|『([^』\n]+)』|“([^”\n]+)”|"([^"\n]+)"|'([^'\n]+)'|[\p{L}\p{N}_./\\:-]+\.[a-z][a-z\d]{0,9}(?![\p{L}\p{N}_.])/giu;
  for (const match of text.matchAll(tokens)) {
    const quoted = match.slice(1).find((part) => part !== undefined);
    let value = quoted ?? match[0];
    let start = match.index;
    // Chinese directives need no whitespace before an unquoted filename.
    if (quoted === undefined) {
      const prefix =
        /^(?:请|最后|最终|并|然后|将结果|把结果)*(?:文件名(?:为|是|叫)?|保存为|另存为|命名为|输出为|写成|写入|写到|保存到|汇总成|整理成|转换成|转成|生成|创建|输出|导出|交付|要)(?:一份|一个)?/u.exec(
          value,
        );
      if (prefix) {
        value = value.slice(prefix[0].length);
        start += prefix[0].length;
      } else if (/^(?:请|帮我|把|将|务必|麻烦|希望|然后)/u.test(value)) continue;
      // 「报告.md和数据.csv」 runs two names together without spaces; an ambiguous bare name is
      // skipped rather than enforced, so a correct two-file plan is never rejected.
      if (/\.[a-z][a-z\d]{0,9}(?:和|与|及|以及|跟|、)/iu.test(value)) continue;
    }
    const name = filename(value);
    if (!name) continue;
    // A cue from an earlier sentence says nothing about this name. "修一下导出按钮…。先阅读
    // input/export.test.ts" used to count the read-only file as a requested output, so the plan was
    // rejected as missing a file nobody asked to deliver (dev-lite run: plan: none).
    const sentence =
      text
        .slice(Math.max(0, start - 200), start)
        .split(/[。；;！!？?\n]/u)
        .at(-1) ?? "";
    const before = sentence;
    // A file name is not a directive: 「先阅读 input/export.ts 和 …」 used to cue on the word
    // "export" inside the name and count a read-only file as a requested output, so the plan was
    // rejected as missing a delivery nobody asked for (dev-lite run). Mask names, keep offsets.
    const spoken = before.replace(NAME_LIKE, (name) => " ".repeat(name.length));
    const cue = [...spoken.matchAll(CUES)].at(-1);
    if (cue && INPUT.test(cue[0])) continue;
    if (
      cue &&
      NAMING.test(cue[0]) &&
      /(?:输入|源|附件|\binput|\bsource)(?:文件|\s+file)?(?:的|\s+)?$/iu.test(
        before.slice(0, cue.index),
      )
    )
      continue;
    if (
      /^\s*(?:作为|是|为|的)?\s*(?:输入文件|源文件|附件|模板|格式|is an? input|as input|as (?:a )?template)/iu.test(
        text.slice(match.index + match[0].length),
      )
    )
      continue;
    // A rejected alternative is not a requested output, even when it has an extension.
    const clause = before.split(/[，,。;；\n!?！？]/u).at(-1) ?? "";
    // 「分别保存为」 means "respectively": 别 inside 分别/特别/类别… is not a negation.
    if (
      /(?:不要|(?<![分特区类告识级个性差派])别|而非|不是|instead of|rather than|\bnot\b)[^，,。;；\n]{0,60}$/iu.test(
        clause,
      )
    )
      continue;
    if (!cue && text.trim() !== match[0]) continue;
    const naming = !!cue && NAMING.test(cue[0]);
    const previous = candidates.at(-1);
    // An immediately following naming clause overrides a provisional name, not other outputs.
    if (
      naming &&
      previous &&
      !previous.naming &&
      /^[\s,，]*(?:文件名(?:为|是)?|命名为?|名为|叫做|file\s*name(?: is)?|named|called)[:：]?\s*$/iu.test(
        text.slice(previous.end, start),
      )
    )
      candidates.pop();
    candidates.push({ name, naming, end: match.index + match[0].length });
  }
  return [...new Set(candidates.map((item) => item.name))].slice(0, 20);
}

const SECTION_CUE =
  /章节|小节|一节|两节|三节|四节|几节|各节|标题|部分|\b(?:sections?|headings?|parts?)\b/iu;
const QUOTED_SECTION =
  /「([^」\n]{1,40})」|『([^』\n]{1,40})』|“([^”\n]{1,40})”|"([^"\n]{1,40})"/gu;

/**
 * Section names the request ties to one requested output: quoted names after that file's mention,
 * before the next requested file or sentence end, with a section word nearby (「PRD.md 要有「背景」
 * 「验收标准」两节」). Anything looser stays unchecked rather than guessed.
 */
export function requestedOutputSections(request: string): Map<string, string[]> {
  const text = request.slice(0, 80_000);
  const names = requestedOutputNames(text);
  const result = new Map<string, string[]>();
  if (!names.length) return result;
  const mentions = names
    .flatMap((name) => {
      const index = text.indexOf(name);
      return index < 0 ? [] : [{ name, index, end: index + name.length }];
    })
    .sort((a, b) => a.index - b.index);
  mentions.forEach((mention, order) => {
    const next = mentions[order + 1]?.index ?? text.length;
    const clause = text.slice(mention.end, next).split(/[。；;！!？?\n]/u)[0] ?? "";
    if (!SECTION_CUE.test(clause)) return;
    const sections = [...clause.matchAll(QUOTED_SECTION)]
      .map((match) => (match.slice(1).find((part) => part !== undefined) ?? "").trim())
      .filter((section) => section && !/\.[a-z][a-z\d]{0,9}$/iu.test(section));
    if (sections.length) result.set(mention.name, [...new Set(sections)].slice(0, 10));
  });
  return result;
}
