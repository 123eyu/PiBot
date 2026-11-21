const acknowledgement =
  /^(?:好的?|当然|没问题|收到|明白|可以|sure|okay|ok|certainly|understood)$/iu;
const waiting = /^(?:请稍等|稍等(?:一下)?|稍候|请稍候|one moment|just a moment|please wait)$/iu;
const chineseAction =
  "(?:查|搜|找|读|打开|检查|执行|操作|处理|运行|继续|获取|计算|生成|创建|编写|修改|保存|整理|收集|核对|验证|连接|下载|上传|发送|安装|配置|开启|关闭|进行|做)";
const englishAction =
  "(?:check|look|search|find|fetch|get|open|read|run|execute|continue|proceed|start|do|work|create|write|generate|update|save|download|upload|send|install|configure|enable|disable|inspect|verify|calculate|collect|review|gather)";
const promise = new RegExp(
  `^(?:(?:我(?:来|去|先|会|将|现在|这就|马上)(?:来|去|先)?|让我(?:先)?|现在(?:就)?开始|接下来我(?:会|将|先)?|先)\\s*${chineseAction}|(?:我)?(?:继续|正在)(?:执行|操作|处理|查询|检查)|(?:first\\s+)?(?:I(?:'ll| will)|we(?:'ll| will)|let me)\\s+(?:now\\s+)?${englishAction}\\b)`,
  "iu",
);
const nextAction = new RegExp(
  `^(?:(?:然后|再|并|接着|随后)\\s*${chineseAction}|(?:and(?: then)?|then)\\s+${englishAction}\\b)`,
  "iu",
);

/** Fail closed on mixed answers: only an entire short, unquoted promise can request a nudge. */
export function promisedWithoutTools(text: string, toolCalls: number): boolean {
  if (toolCalls !== 0 || text.length > 800) return false;
  const sample = text.trim().replace(/[’‘]/gu, "'");
  if (
    !sample ||
    /[`"“”「」『』<>?？:：=]/u.test(sample) ||
    /如需|如果|假如|假设|除非|若需|若要|(?:等|待)(?:你|您)|(?:你|您)(?:确认|同意|选择)|请(?:先)?(?:确认|告诉|选择|回复|提供|恢复|授权)|是否|可以吗|好吗|要不要|需不需要|能否|建议|例如|示例|举例|原话|引用|用户|你说|不能|无法|未能|没有|不会|无需|不需要|不再|不要|\b(?:if|unless|when|once|would|could|should|confirm|example|quote|not|cannot|can't|won't|unable)\b/iu.test(
      sample,
    ) ||
    /已经|已完成|完成了|查到|查得|发现|结果(?:是|为|如下)|答案|结论|如下|[0-9]\s*(?:°|℃|%)|\b(?:is|are|equals|found|shows|result|answer)\b/iu.test(
      sample,
    )
  )
    return false;
  const clauses = sample
    .split(/[。.!！\n，,;；]|—| - /u)
    .map((part) => part.trim())
    .filter(Boolean);
  let claimed = false;
  for (const clause of clauses) {
    if (acknowledgement.test(clause) || waiting.test(clause)) continue;
    if (promise.test(clause)) claimed = true;
    else if (!claimed || !nextAction.test(clause)) return false;
  }
  return claimed;
}
