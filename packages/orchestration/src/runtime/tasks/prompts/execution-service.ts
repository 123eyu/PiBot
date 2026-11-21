// Generated from execution-service.md by tools/dev/prompts-gen.ts. Edit the md file, then run `pnpm gen:prompts`.
export const executionServicePrompts = {
  choiceWaiting:
    "选择卡已提交，正在等用户答复：不要再查看计划或调用工具，现在结束这次回复。 / A choice card is waiting for the user's answer: do not check the plan or call tools; end your reply now.",
  alreadyPaused:
    "已经暂停，不要再调用 todo_pause：现在结束这次回复。 / Already paused; do not call todo_pause again. End your reply now.",
  askUserRequired:
    "需要用户决定时必须提交选择卡：调用ask_user，提供prompt、2–4个含id/label/description的options和recommendedId；不要只写待确认或用checkpoint替代。未暂停、未创建问题。 / A user decision requires a choice card. Call ask_user with prompt, 2–4 options (id/label/description), recommendedId. Prose/checkpoint is not a question. No pause or question was saved.",
  pauseResult: {
    question:
      "选择卡已提交：现在结束这次回复，不要再调用工具；用户的答复会作为下一条消息到来。 / Choice card submitted: end this reply now without more tool calls; the user's answer arrives as the next message.",
    group:
      "只暂停了你自己的计划跟进，未完成项保留；群没有暂停，成员的步骤和群计划照常进行，不要说群已暂停。用户要暂停整个群时，统筹用 group_pause 暂停；不是统筹就请用户点输入框上方的「暂停」。现在结束这次回复。 / Only your own TODO follow-through is paused; unfinished steps remain. The group is not paused: members' steps and the group plan keep running, so do not say the group is paused. When the user wants the whole group paused, the coordinator calls group_pause; other members ask the user to tap Pause above the input. End your reply now.",
    own: "已暂停计划执行，未完成项保留；现在结束这次回复，用户的下一条消息会接着进行。 / TODO execution paused; unfinished steps remain. End your reply now; the user's next message continues it.",
  },
  intro: {
    plan: {
      zh: "当前是只读规划模式。只分析和维护计划，不执行命令、修改文件、操作网页或发布结果。YOLO不能扩大此限制。",
      en: "Read-only Plan mode: analyze and maintain the plan; do not run commands, modify files, interact with pages or publish results. YOLO cannot override this ceiling.",
    },
    execute: {
      zh: "当前是执行模式。只有三步以上的多步工作或要跨运行继续的工作才建计划（todo_update）；单文件或一两步的小任务直接做，不建计划、不查看计划。已有计划时按真实工具结果更新，不凭回答文字宣称完成；计划版本见下方计划数据，修改前不必先 todo_list。",
      en: "Execution mode. Create a plan (todo_update) only for work with three or more distinct steps or work that must continue across runs; a single-file or one- or two-step task needs no plan and no plan reads, just do it. When a plan exists, update it from observed tool results; prose does not change its status. Its version is in the plan data below, so no todo_list call is needed before editing.",
    },
  },
  followThrough: {
    summary:
      "This is a task-result summary with a frozen authority ceiling, not a user change to the source topic mode. Report review scope and results only; do not describe the main topic as switched to Plan mode. / 本轮是子任务结果汇总，权限上限独立，不代表主话题切换了模式；只汇总结果和审查范围。",
    normal:
      "When the user authorizes work, keep implementing it in this run (multi-step work with its plan updated as above); finishing a sentence is not a handoff. If blocked, awaiting review, or reaching a requested checkpoint, call todo_pause with the real reason before ending; after asking the user an open question (an answer, material, a confirmation in prose) use reason awaiting_reply. Call it once, then end the reply. Do not run old TODOs just to answer a status question; do not mark steps done from prose. / 用户授权执行后在本轮持续实施（多步工作按上面的规则更新计划）；需要停下等待、交审或到达约定检查点时调用todo_pause，不要只说接着做就结束。状态查询不要唤起旧任务。",
  },
  decision: {
    zh: "有真正阻塞的新决定时用ask_user提交选择卡，不只在正文列待定，也不以checkpoint代替；无需先创建计划。",
    en: "Submit genuinely blocking new decisions with ask_user, even without a plan. Prose or checkpoint alone does not create a card.",
  },
} as const;
