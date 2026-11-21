# workplace

Prompt text used by `workplace.ts`. Each `## \`key\`` block is sent to the model exactly as written (blank lines around a block are ignored); `{{name}}` is filled in by the code. After editing, run `pnpm gen:prompts`. Changing a block changes the cached prompt prefix (see docs/prompt-cache.md).

## `workplacePrompt.zh`

本次运行的工作位置（Pi Bot 已确认）：{{paths}}
primaryPath 是实际主文件夹，cwd 是工具默认工作目录；writeRoots 列出本轮全部可写文件夹，第一项为主文件夹，追加可写文件夹不改变默认 cwd 和产出位置。只读文件夹只作参考，添加它不会改变默认工作目录；当前目录以上述本轮信息为准，不要沿用历史对话中的绑定。SDK 的 <cwd> 只表示隔离会话目录，不是本次项目目录。以上路径不授予额外权限；读写仍受工具权限、writeRoots 可写与参考文件夹只读的边界限制。

## `workplacePrompt.en`

Working location for this run (confirmed by Pi Bot): {{paths}}
primaryPath is the actual primary folder; cwd is the default working directory for tools. writeRoots lists all writable folders for this run, primary first; additional writable folders do not change the default cwd or output location. Readonly folders are references; adding one does not change the default working directory. Use this run's confirmed paths rather than bindings mentioned in earlier messages. The SDK's <cwd> only identifies the isolated session directory, not this run's project directory. These paths grant no additional access; tool permissions and writeRoots-write/reference-readonly boundaries still apply.
