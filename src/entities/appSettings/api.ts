import { invoke } from "@tauri-apps/api/core";

/**
 * 读取系统级开机自启状态；该状态以操作系统启动项为准，不落入 SQLite 设置表
 */
export function isAutostartEnabled(): Promise<boolean> {
  return invoke<boolean>("is_autostart_enabled");
}

/**
 * 切换系统级开机自启状态，后端会同步托盘勾选状态并通知设置页刷新
 */
export function setAutostartEnabled(enabled: boolean): Promise<boolean> {
  return invoke<boolean>("set_autostart_enabled", { enabled });
}

/**
 * 判断本次进程是否由开机自启拉起。
 *
 * 与 `isAutostartEnabled` 的区别：那个读的是「自启功能是否已开启」这一持久设置，
 * 这个只回答「这一次启动是不是自启触发的」，用于决定启动后是否显示设置窗口。
 */
export function isAutostartLaunch(): Promise<boolean> {
  return invoke<boolean>("is_autostart_launch");
}
