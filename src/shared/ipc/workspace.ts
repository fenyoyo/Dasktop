import { listen, type Event, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * 二次启动携带工作区参数时由后端广播。
 *
 * 用户双击工作区快捷方式时，若主实例已在运行，参数无法通过命令行传给
 * 已在挂载的前端，因此由后端主动推送该事件，让前端立即触发还原。
 */
export const STARTUP_WORKSPACE_REQUESTED_EVENT = "dasktop://startup-workspace-requested";

/**
 * 监听二次启动的工作区还原请求，事件载荷为工作区 ID。
 */
export async function listenStartupWorkspaceRequested(
  handler: (event: Event<string>) => void | Promise<void>,
): Promise<UnlistenFn> {
  return listen<string>(STARTUP_WORKSPACE_REQUESTED_EVENT, handler);
}
