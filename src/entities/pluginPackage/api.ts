import { invoke } from "@tauri-apps/api/core";
import type { PluginScanResult } from "./types";

/**
 * 插件宿主命令的前端封装。
 *
 * 这一层只负责参数搬运，不做权限判断：权限门控统一由受控上下文承担，
 * 因此本模块刻意不导出给插件使用，只由加载器与宿主面板调用。
 */

/**
 * 扫描插件根目录。
 *
 * 首次调用会在插件根目录为空时写入内置示例插件包，因此返回值里的
 * `packages` 在全新安装后也不为空。
 */
export function listPlugins(): Promise<PluginScanResult> {
  return invoke<PluginScanResult>("list_plugins");
}

/**
 * 读取插件入口源码。
 *
 * 返回原始文本而不是可执行对象：把源码变成模块是前端加载器的职责，
 * 宿主后端不参与任何代码转换。
 */
export function readPluginEntry(pluginId: string): Promise<string> {
  return invoke<string>("read_plugin_entry", { pluginId });
}

/**
 * 读取插件包内文本文件，路径相对插件包目录，越界访问由后端拒绝。
 */
export function readPluginPackageFile(pluginId: string, relativePath: string): Promise<string> {
  return invoke<string>("read_plugin_package_file", { pluginId, relativePath });
}

/**
 * 写入插件包内文本文件，路径相对插件包目录，越界写入由后端拒绝。
 */
export function writePluginPackageFile(
  pluginId: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  return invoke("write_plugin_package_file", { pluginId, relativePath, contents });
}

/**
 * 追加插件运行日志，宿主按插件分文件存放并限制单文件体积。
 */
export function writePluginLog(pluginId: string, level: string, message: string): Promise<void> {
  return invoke("write_plugin_log", { pluginId, level, message });
}

/**
 * 发送宿主通知，后端会同时广播事件并写入插件日志。
 */
export function notifyFromPlugin(pluginId: string, title: string, message: string): Promise<void> {
  return invoke("notify_from_plugin", { pluginId, title, message });
}

/**
 * 用系统资源管理器打开插件根目录。
 */
export function openPluginRoot(): Promise<void> {
  return invoke("open_plugin_root");
}
