import { invoke } from "@tauri-apps/api/core";
import type {
  BoxConflictPolicy,
  BoxDeletePolicy,
  BoxDropAction,
} from "@/entities/appSettings/types";

/**
 * 打开 Windows 原生文件夹选择器，返回用户选中的 Box 收纳根目录；取消选择时返回 null
 */
export function chooseCollectionRootFolder(): Promise<string | null> {
  return invoke<string | null>("choose_collection_root_folder");
}

/**
 * 在收纳根目录下创建单个 Box 对应的真实文件夹，物理目录名由前端用 Box ID 生成以保持稳定
 */
export function createBoxFolder(rootPath: string, folderName: string): Promise<string> {
  return invoke<string>("create_box_folder", {
    rootPath,
    folderName,
  });
}

/**
 * 按删除策略处理真实收纳文件夹；成功后前端才允许删除 Box 数据库记录
 */
export function deleteBoxFolder(
  folderPath: string,
  desktopPath: string,
  policy: BoxDeletePolicy,
  conflictPolicy: BoxConflictPolicy,
): Promise<void> {
  return invoke("delete_box_folder", {
    folderPath,
    desktopPath,
    policy,
    conflictPolicy,
  });
}

/**
 * 将单个 Box 的真实文件夹迁移到新的收纳根目录；返回后端实际落盘的新路径
 */
export function migrateBoxFolder(folderPath: string, rootPath: string): Promise<string> {
  return invoke<string>("migrate_box_folder", {
    folderPath,
    rootPath,
  });
}

/**
 * 用系统默认 Explorer 打开真实收纳文件夹，便于用户在独立窗口里检查文件位置
 */
export function openBoxFolder(folderPath: string): Promise<void> {
  return invoke("open_box_folder", {
    folderPath,
  });
}

/**
 * 按拖入策略把外部文件复制、移动或映射到 Box 真实文件夹；路径必须来自系统拖放事件
 */
export function handleBoxDroppedPaths(
  folderPath: string,
  paths: string[],
  action: BoxDropAction,
  conflictPolicy: BoxConflictPolicy,
): Promise<string[]> {
  return invoke<string[]>("handle_box_dropped_paths", {
    folderPath,
    paths,
    action,
    conflictPolicy,
  });
}

/**
 * 按拖出策略把 Box 内文件复制、移动或映射到 Windows 桌面目录；路径必须来自 Box 文件网格。
 */
export function handleBoxDraggedPathsToDesktop(
  desktopPath: string,
  paths: string[],
  action: BoxDropAction,
  conflictPolicy: BoxConflictPolicy,
): Promise<void> {
  return invoke("handle_box_dragged_paths_to_desktop", {
    desktopPath,
    paths,
    action,
    conflictPolicy,
  });
}

/**
 * 把 Box 窗口固定为「置顶 + 免疫 Win+D」，保证显示桌面时 Box 不被隐藏。
 * 底层失败时返回错误，由调用方降级为普通顶层窗口。
 */
export function glueBoxWindowToDesktop(windowLabel: string): Promise<void> {
  return invoke("glue_box_window_to_desktop", { windowLabel });
}
