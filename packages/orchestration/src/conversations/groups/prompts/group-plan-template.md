# group-plan-template

Prompt text used by `group-plan-template.ts`. Each `## \`key\`` block is sent to the model exactly as written (blank lines around a block are ignored); `{{name}}` is filled in by the code. After editing, run `pnpm gen:prompts`. Changing a block changes the cached prompt prefix (see docs/prompt-cache.md).

## `cardState`

用户运行了常用计划「{{name}}」，程序已把它作为计划提交，卡片状态：{{status}}。pending 表示等用户在卡片上点开始；started 表示已登记执行；starting 表示请用户在卡片上核对。简短告诉用户即可，不要再提交 group_plan 或另行分派。 / The user ran the saved plan; the program submitted it as a plan, card status: {{status}}. Tell the user briefly; do not resubmit group_plan or assign work.

## `registerFailed`

程序未能登记这份常用计划（执行模式、预算或执行引擎不可用）。向用户说明阻塞并停止，不要另行分派。 / The program could not register this saved plan (execution mode, budget or engine unavailable). Explain the block and stop; do not assign work.

## `invalid`

常用计划没有通过计划校验（成员可能已离开或变化）：{{issues}}。可按当前成员改写后用 group_plan 提交（剩余 {{rewritesLeft}} 次），否则说明阻塞并停止。 / The saved plan failed plan validation (a member may have left or changed): {{issues}}. Rewrite it for the current members and submit with group_plan, or explain the block and stop.

## `document.zh.description`

从一次全部通过的群计划保存，共 {{steps}} 步。每次运行都按计划规则重新校验，复杂计划仍等你确认。

## `document.zh.body.item2`

运行时，统筹不会重新规划：程序把合同里的步骤作为计划重新提交，照常校验负责人、依赖、交付物和验收；步骤多或预估花费高时先出计划卡片等你点「开始」；预算按本群当时的设置执行，卡住时照常重新规划。

## `document.zh.body.item3`

运行前在表单里填写「输入」；上次运行的文件、附件、来源链接和记录编号都没有保存。

## `document.en.description`

Saved from a group plan whose {{steps}} steps all passed. Each run is validated again under the plan rules; complex plans still wait for your confirmation.

## `document.en.body.item2`

When it runs, the coordinator does not plan again: the program submits the contract's steps as a plan and validates owners, dependencies, deliverables and checks as usual. Plans with many steps or a high estimate wait for your Start on the plan card; budgets follow this group's settings at run time, and stuck steps are replanned as usual.

## `document.en.body.item3`

Fill in the inputs in the run form; files, attachments, source links and record ids from the earlier run were not saved.
