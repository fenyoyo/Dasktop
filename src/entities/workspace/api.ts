import { invoke } from "@tauri-apps/api/core";
import type {
  WorkspaceRestoreOutcome,
  WorkspaceWindow,
} from "./types";

/**
 * 捕获当前桌面的应用窗口布局。
 *
 * excludedExecutables 用于排除 Dasktop 自身进程，避免把设置窗口写进工作区。
 */
export async function captureWorkspaceLayout(
  excludedExecutables: string[],
): Promise<WorkspaceWindow[]> {
  return invoke<WorkspaceWindow[]>("capture_workspace_layout", { excludedExecutables });
}

/**
 * 按保存的窗口列表启动应用并还原窗口位置，随后执行附加命令。
 *
 * 窗口列表的顺序即启动顺序；`launchIntervalSeconds` 是相邻两次启动之间的
 * 等待秒数，0 表示不等待；`commands` 在应用全部还原完成后按顺序执行。
 */
export async function restoreWorkspaceLayout(
  windows: WorkspaceWindow[],
  launchIntervalSeconds: number,
  commands: string[],
): Promise<WorkspaceRestoreOutcome> {
  return invoke<WorkspaceRestoreOutcome>("restore_workspace_layout", {
    commands,
    launchIntervalSeconds,
    windows,
  });
}

/**
 * 读取当前 Dasktop 进程的可执行文件路径，用于构造捕获时的排除列表。
 */
export async function resolveCurrentExecutablePath(): Promise<string> {
  return invoke<string>("resolve_current_executable_path");
}

/**
 * 在桌面创建工作区快捷方式，返回快捷方式完整路径。
 */
export async function createWorkspaceDesktopShortcut(
  desktopPath: string,
  workspaceId: string,
  workspaceName: string,
): Promise<string> {
  return invoke<string>("create_workspace_desktop_shortcut", {
    desktopPath,
    workspaceId,
    workspaceName,
  });
}

/**
 * 读取启动命令行中的 `--workspace` 参数。
 *
 * 桌面快捷方式以 Dasktop 自身为目标并携带工作区 ID，
 * 未携带该参数时返回 null，普通启动路径不受影响。
 */
export async function resolveStartupWorkspaceId(): Promise<string | null> {
  return invoke<string | null>("resolve_startup_workspace_id");
}

/**
 * 批量解析应用可执行文件的图标，返回「路径 → data URL」映射。
 *
 * 解析失败的条目不会出现在结果中，调用方需自行回退到占位图标。
 */
export async function resolveExecutableIcons(
  executablePaths: string[],
): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("resolve_executable_icons", { executablePaths });
}
