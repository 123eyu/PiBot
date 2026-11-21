# group-workflow-brief

Prompt text used by `group-workflow-brief.ts` (a plan step's brief). Each `## \`key\`` block is sent to the model exactly as written (blank lines around a block are ignored); `{{name}}` is filled in by the code. After editing, run `pnpm gen:prompts`. Changing a block changes the cached prompt prefix (see docs/prompt-cache.md). These lines are appended at the end of a brief, and only to the rerun of a step the group's pause stopped, so other briefs keep their text.

## `resumed`

这一步因群组暂停被中断，现在继续：暂停期间文件可能有变化（包括用户的修改），继续前先重新读取你要依赖的文件和当前进度，已经完成的部分不要重做。 / This step was interrupted by the group pause and is continuing now: files may have changed during the pause (including by the user). Re-read the files and progress you rely on before editing, and don't redo parts that are already done.

## `resumedLost`

这一步之前在自己工作区里还没合并的改动没能保留，这次从当前的群文件夹开始。 / The unmerged changes this step had made in its own workspace could not be kept; this run starts from the current group folder.
