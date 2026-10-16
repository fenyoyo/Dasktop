import { invoke } from "@tauri-apps/api/core";
import type { ForegroundPinHotkeyRegistration } from "./types";

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

/**
 * 读取「把当前前台窗口置顶 / 取消置顶」全局快捷键的配置与可用状态。
 *
 * 配置由 Rust 侧独占读写（两个键必须一起校验、一起落库、一起重挂），因此前端不直连
 * 设置表，一律走这条命令。
 */
export function listForegroundPinHotkey(): Promise<ForegroundPinHotkeyRegistration> {
  return invoke<ForegroundPinHotkeyRegistration>("list_foreground_pin_hotkey");
}

/**
 * 写入上述全局快捷键配置并立即重挂到系统，返回写入后的状态供面板刷新展示。
 *
 * 快捷键合法性由 Rust 侧判定（与插件热键共用同一套规则），失败时命令以错误文案拒绝，
 * 由调用方展示给用户，前端不重复实现规则。
 */
export function setForegroundPinHotkey(
  accelerator: string,
  enabled: boolean,
): Promise<ForegroundPinHotkeyRegistration> {
  return invoke<ForegroundPinHotkeyRegistration>("set_foreground_pin_hotkey", {
    accelerator,
    enabled,
  });
}
