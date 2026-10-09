import { invoke } from "@tauri-apps/api/core";
import type { PluginScanResult } from "./types";

/**
 * 插件宿主命令的前端封装。
 *
 * 这一层只负责参数搬运，不做权限判断。
 *
 * 注意这里**只有宿主自己用的三条命令**。插件能调的五条能力命令（读写包内文件、写日志、
 * 发请求、发通知）不经过这里：它们由插件页面里的能力桥直接调用，插件代码与宿主前端
 * 是两套东西。宿主再包一层只会让人以为「插件能力由宿主代码发起」。
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
 * 打开插件的界面窗口；窗口已存在时只把它调到前台。
 *
 * 建窗与「已存在就聚焦」的判断都在 Rust 侧，不在这里——能力桥只能在建窗时注入
 * （Tauri 的前端窗口选项不透出初始化脚本），而它必须在插件自己的脚本执行之前就绪。
 * 前端只负责说「打开这个插件」。
 */
export function openPluginWindow(pluginId: string): Promise<void> {
  return invoke("open_plugin_window", { pluginId });
}

/**
 * 用系统资源管理器打开插件根目录。
 */
export function openPluginRoot(): Promise<void> {
  return invoke("open_plugin_root");
}
