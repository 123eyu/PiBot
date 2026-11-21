import type { ReportVerdict } from "@pibot/protocol-base";

export function reportVerdict(text: string): ReportVerdict | undefined {
  let fence: string | undefined;
  let verdict: ReportVerdict | undefined;
  // A heading that is only 「结论」/ Verdict may carry the word on the next non-empty line.
  let headingOnly = false;
  for (const line of text.split(/\r?\n/u)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence || /^\s*>/u.test(line)) continue;
    if (!verdict) {
      const plain = line
        .trim()
        .replace(/^#{1,6}\s*/u, "")
        .replace(/\*\*/gu, "");
      if (!plain) continue;
      // 「结论：通过（Verdict: PASS）」 or 「结论：不通过 — 两项」 still states one verdict: only a
      // separator may follow the word, so 「通过率」 or 「PASSED」 do not count (2026-11-19, two
      // reports were sent back for a bracketed note).
      const match =
        /^(?:结论|verdict)\s*[:：]\s*(不通过|通过|PASS|FAIL)(?=$|[\s（(，,。.!！；;:：—–-])/iu.exec(
          plain,
        ) ??
        (headingOnly
          ? /^(不通过|通过|PASS|FAIL)(?=$|[\s（(，,。.!！；;:：—–-])/iu.exec(plain)
          : null);
      headingOnly = /^(?:结论|verdict)\s*[:：]?$/iu.test(plain) && /^\s*#{1,6}\s/u.test(line);
      if (match)
        verdict = {
          verdict: /^(?:通过|pass)$/iu.test(match[1] ?? "") ? "pass" : "fail",
          failures: [],
        };
      continue;
    }
    // A later conclusion starts a different report section; only the first one counts. The
    // same verdict restated in the other language (「结论：不通过」 then 「Verdict: FAIL」) is
    // one report: Mac acceptance 2026-11-20 showed 「不通过（0 项）」 when it ended collection.
    if (/^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:结论|verdict)(?:\*\*)?\s*[:：]/iu.test(line)) {
      const again =
        /[:：]\s*(?:\*\*)?\s*(不通过|通过|PASS|FAIL)(?=$|[\s（(，,。.!！；;:：—–*-])/iu.exec(line);
      const same =
        again && (/^(?:通过|pass)$/iu.test(again[1] ?? "") ? "pass" : "fail") === verdict.verdict;
      if (same) continue;
      break;
    }
    if (verdict.verdict === "fail" && verdict.failures.length < 10) {
      const item = /^\s*(?:[-+*]|\d+[.)、])\s+(.+)$/u.exec(line)?.[1]?.trim();
      if (item) verdict.failures.push(item.slice(0, 200));
    }
  }
  return verdict;
}
