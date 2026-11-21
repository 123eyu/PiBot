/**
 * Renderer kit: the renderer's kernel API, what a capability's `/ui` entry may use from
 * the app shell. It owns the React contexts and their value types (brain RPC, settings and
 * language, navigation, workspace data) and the shared shell widgets; the desktop app owns the
 * providers that fill those contexts. Like `@pibot/brain/kit` on the brain side, this file is the
 * complete list of what capabilities depend on.
 */
export { ApprovalExplanation } from "./components/ApprovalExplanation.tsx";
export { default as approvalStyles } from "./components/approval.module.css";
export { PermissionRow } from "./components/PermissionRow.tsx";
export { Overlay } from "./dialogs/Overlay.tsx";
export { useSettingsDialog } from "./dialogs/use-settings-dialog.ts";
export { hostPlatform } from "./host/platform.ts";
export * from "./navigation/context.ts";
export { SETTINGS_SECTIONS } from "./navigation/settings-sections.ts";
export * from "./rpc/context.ts";
export { waitRpc } from "./rpc/wait.ts";
export * from "./settings/context.ts";
export * from "./widgets/app-select.tsx";
export * from "./widgets/bot-avatar.tsx";
export { default as botPanelStyles } from "./widgets/bot-panel.module.css";
export * from "./widgets/date-field.tsx";
export * from "./widgets/folders/folder-picker.tsx";
export * from "./widgets/folders/runner-folders.ts";
export * from "./widgets/folders/selection.ts";
export * from "./widgets/model-options.ts";
export { normalizedThinking } from "./widgets/normalized-thinking.ts";
export { PopupMenu } from "./widgets/PopupMenu.tsx";
export {
  RevealFileButton,
  type RevealFileSource,
  revealFileLabel,
} from "./widgets/RevealFileButton.tsx";
export * from "./widgets/settings-layout.tsx";
export { default as setupStyles } from "./widgets/setup/setup.module.css";
export { requirePeer, SetupError } from "./widgets/setup/setup-error.ts";
export { TaskStatus } from "./widgets/setup/task-status.tsx";
export { useTask } from "./widgets/setup/use-task.ts";
export * from "./workspace/actions.ts";
export * from "./workspace/context.ts";
export * from "./workspace/image-model-page.ts";
export * from "./workspace/locate.ts";
export * from "./workspace/locate-group-thread.ts";
