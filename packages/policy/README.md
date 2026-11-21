# @pibot/policy

权限裁决和命令事实分析的 Node 包，不依赖 Electron，也不导出 pi 类型。
本包实现裁决、命令/路径事实、危险清单、grants 和样例脚本；不执行命令、写文件、联网或持久化审批。

## 接入接口

```ts
const policy = await createPolicy({
  platform: "darwin", userHome: userHomeDir, resourcesDir,
  // fs?: { realpath(path, signal): Promise<string> }
});
const result = await policy.evaluate({
  botId, request: { category: "run_command", command, cwd },
  settings, botOverrides, grants, workplace, signal,
  // realpath?: (path, signal) => Promise<string>
});
policy.dispose();
```

- 入口导出 `createPolicy(options): Promise<Policy>`、`createEvaluator(options, analyze)`、`createCommandAnalyzer(options)`、`effectiveLevel`、`createGrantScope`、`matchesGrant`、路径 helper/类型及常量表。Policy 提供 evaluate/analyzeCommand/dispose；factory 不创建模块全局服务，dispose 同时取消在途裁决并释放 Parser。
- options 的 platform 是 darwin/linux/win32，userHome 是**用户**主目录（用于 `~`）；Bot 主目录和当前工具 cwd 来自 `workplace: Workplaces`，不改变 pi sessionPaths。默认 fs 用 Node realpath，可按 factory 或单次 evaluate 注入；整个裁决最长10秒，接受调用方取消。
- request 用 category 判别：run_command `{command,cwd?}`；read_file/list_dir/write_file `{path}`；web `{url}`；其他四类恒 deny。edit_file 映射 write_file，其他工具映射由 brain 做。
- settings 是存储层的 PermissionsSettings（levels/network/pathEntries），workplace 是 Workplaces；botOverrides 只能收紧，已有 grants 按有效状态传入。policy 不反向依赖 store，不访问数据库/日志/Key/环境变量。
- result 为 `{decision,reason,risk,facts,canRemember,grantScope?,analysis?,path?,cwd?,command?,url?,domain?}`。reason 为稳定代码；facts 严格符合 ApprovalFact（kind/value/risk）。warning值为 readonly/incomplete_analysis/windows_unisolated或危险规则ID，界面映射i18n，brain映射面向模型的安全理由（外部写拒绝需说明只能写工作位置），本包不依赖i18n。Windows保留command原文，仅给无隔离warning，不加载Bash WASM且不记住。
- 先做硬拒（提权、外部写/删、网站本机内网/名单），然后全局/Bot never、危险、不完整、grants、恒ask的Jev、档位；unknown/动态/ERROR 即使档位always或命中旧grant也 ask/不可记住。外部读/列目录默认ask，独立读工具可记住所在文件夹；命令涉及外部读无法证明只读，ask/不可记住。
- `createGrantScope(result)` 只返回符合 grants 存储结构的 scope，不生成UUID/时间/写库；brain 把 `{botId,category,scope}` 给 GrantsRepo，并与审批/审计同事务。programs去重排序、**同一集合**+同一canonical工作根；生成/匹配程序scope前，cwd及全部canonical读写路径必须落在该根内，跨关联工作位置按当前档位裁决且不生成scope/不可记住；folder按路径边界包含；workplace精确根；domain精确小写/punycode，不含子域名，撤销或别的Bot均不匹配。
- `canonicalPath(value,context)` 按组件 realpath 后再处理 `..`，防止预先折叠 `link/../x`；ENOENT保留最近存在父目录，默认FS用lstat拒绝悬空符号链接，其他FS错误拒绝。注入FS可提供isSymbolicLink，单次realpath覆盖需自行保证ENOENT不是悬空链接。containsPath用平台path API/分隔符边界，Windows不区分大小写；纯模拟FS不碰用户目录。
- `analyzeCommand(command)` 是同步语法分析，长度≤32768、嵌套shell≤3；analysis-budget.ts的100ms/十万操作预算覆盖解析回调、AST遍历、包装器和find展开，耗尽标不完整。包装器用游标迭代，find的每个exec/execdir/ok/okdir按`;`/`+`独立入队（嵌套动作≤64）；不展开变量/通配符、不执行命令。未知选项/环境覆盖/cd等保守处理；自定义绝对可执行路径不当系统同名只读程序。
- 采用白名单：options.ts将程序的选项表编译为OptionRule（none/value/optional、read/write路径或普通值、mutates/unbounded），一次parseOptions产出flags/values/operands/reads/writes/readonly/incomplete/unknownOptions；arguments.ts形成统一ArgumentFacts，command-facts.ts只合并它，commands.ts不再重新运行只读判定。readonly-programs.ts的isReadonlyCommand(command,platform?)也复用该入口。analysis新增unknownOptions（字符串列表），未知选项/缺少参数/组合中未知字母都不完整、不可记住，always及已有grant仍ask；已知外部写优先deny。
- program-options.ts列只读程序选项；mutating-options.ts列cp/mv/install/rm/tee/dd/tar/rsync等，git-options.ts按子命令分别列，find-actions.ts列单短横线谓词/动作，wrapper-options.ts列env/time/xargs等。路径提取只用这一份参数消费结果，grep/rg的e是模式、f是读文件；find动作argv由统一结果交给invocations.ts逐段展开。未列入的选项不猜测参数归属，不扩大白名单。已知的递归跟随链接选项通过unbounded元数据标不完整（rg -L/--follow、grep -R/--dereference-recursive、du -L/--dereference、ls -L/--dereference、find -L），入口路径不能证明所有链接目标范围，所以always/已有grant也ask、不可记住；明确操作数的链接仍先realpath，默认不跟随递归链接的命令可正常匹配scope。
- sed.ts区分GNU可选附着-i后缀与BSD必须后缀（空串也算）；macOS PATH可能指到GNU sed，因此合并两种解释的读写事实并保守标记不完整；输入文件及备份目标都记写（含*替换、带路径后缀）。sed脚本可能另行读写/执行，因此始终ask/不可记住，已知外部写deny。Windows仍不做Bash解析。
- `dangerous.ts` 数据表涵盖外部删除/权限、根删除、系统设置、force push/远端hard reset、kill/关机；外部写先deny，不弹危险允许卡。下载程序与shell同命令保守视为下载即执行。
- web 可检查URL协议/身份信息、字面本机/内网地址、联网名单。**执行层必须绑定实际DNS地址并在每次重定向复查**，不可用本层结果替代连接边界。公网IPv6字面URL可以询问访问，但 DomainSchema不接受IPv6 scope，故不给 domain/grantScope，也不可记住；网络列表模式直接拒绝无可匹配域名的URL。
- policy不做文件写前复查/临时文件rename、命令隔离、审批历史还原或90天审计清理；这些分别由执行层、brain 和存储层接入，brain 必须在执行前重判最新权限/grants，并将结果中的command/facts等脱敏后入库/发事件。

## 样例核对

`pnpm --filter @pibot/policy fixtures` 打印 `src/fixtures.ts` 聚合的383条样例（command-fixtures.ts原128条、review-fixtures.ts前轮39条、whitelist-fixtures.ts157条、boundary-fixtures.ts59条；含always档位、已有grant及注入darwin平台的字符串分析），核对程序/路径/联网/不完整/风险/裁决/记住资格，新样例还核对readonly/unknownOptions/reason/grantScope，支持注入多个工作位置和指定授权根，差异退出码1。使用注入FS，没有Vitest新用例或命令执行/网络；可传 `--resources-dir=<绝对目录>` 在新进程加载外部WASM。

Node26已取消TypeScript transform模式，protocol的参数属性不能直接strip执行；`scripts/fixtures.mjs` 用仅开发依赖 esbuild@0.28.2 的同步load hook保留源URL并转TS。该版本已存在于工作区锁文件，新增直接依赖不升级其他包；protocol/zod运行依赖用于共用设置类型和边界校验。

开发模式、外部Resources路径样例和真实临时FS冒烟可在纯Node验证；Electron/真实asar与三平台路径/执行整合由桌面端负责。下方「摸底结论」是初次探路历史，macOS x64后续已实测通过。

## 摸底结论

### 精确版本与 Node 验证（2026-10-09）

- `web-tree-sitter@0.27.1`、`tree-sitter-bash@0.25.1`，均 MIT；分别用于纯 WASM 解析引擎和 Bash 语法。
- npm 产物已经附带 `web-tree-sitter.wasm`（210415 bytes）和 `tree-sitter-bash.wasm`（1358224 bytes），无需安装 CLI 或本机编译 grammar。
- Node `26.11.1` 已成功 init、load grammar、setLanguage、parse；管道、命令替换、重定向、heredoc、sudo 命令均得到 AST，rootNode.hasError=false。
- Electron `44.7.0` utilityProcess 的加载和真实 asar/Resources 组合待沙箱外验。

### API 与资源路径

```ts
import { Parser, Language } from "web-tree-sitter";
await Parser.init({ locateFile: () => coreWasmPath });
const language = await Language.load(bashWasmPath);
const parser = new Parser();
parser.setLanguage(language);
const tree = parser.parse(command);
// 解析/提取事实后释放 tree，服务关闭时释放 parser。
tree?.delete();
parser.delete();
```

- 0.27.1 使用具名 Parser/Language，不套旧版默认导出样例；Language 没有 delete 方法，Tree/Parser 有。
- 开发模式以 policy 包为 resolve 锚点：`require.resolve("web-tree-sitter/web-tree-sitter.wasm")` 和 `require.resolve("tree-sitter-bash/tree-sitter-bash.wasm")`；不 import tree-sitter-bash 的 Node 绑定。
- tree-sitter-bash 的 install 是 node-gyp-build，被 pnpm 默认跳过；本包只用随包 WASM，不需要批准该 native 构建、不需要 tree-sitter 原生 peer。
- 两个 WASM 都要打包，不能只带 grammar：beforePack 暂存 `out/native-resources/wasm/`，extraResources 复制到 Resources/wasm；locateFile 必须指向外部 core WASM。
- packaged 路径由桌面端注入：`join(resourcesDir,"wasm","web-tree-sitter.wasm")` / `join(resourcesDir,"wasm","tree-sitter-bash.wasm")`，不把 .pnpm/源码绝对路径写进生产包。
- JS runtime 作为 policy 的运行时依赖经桌面依赖闭包进 asar，WASM 在 asar 外，无需对 WASM 再 asarUnpack；stage 目录从 app.asar 的 out/** 中排除，避免重复。
- policy 的工厂接受资源路径注入，入口只解析依赖，避免模块顶层建 Parser 或可变全局服务。

### 后续裁决注意

- AST 是语法，不是「真实会访问哪些文件」的证明；动态变量/通配符/未知程序和 ERROR/MISSING 一律 ask、不记住。
- readonly-programs.ts 必须按程序选项/子命令判断，find -exec/-delete 等不算只读。
- Windows PowerShell 不用此 grammar；一律 ask、不可记住并显示无隔离。
- fixtures（至少80条）由本包维护，供审查和手工核对。

参考：[web-tree-sitter 官方用法](https://github.com/tree-sitter/tree-sitter/blob/master/lib/binding_web/README.md)、[Bash grammar](https://github.com/tree-sitter/tree-sitter-bash)；以安装的 0.27.1/0.25.1 声明与产物为准。
