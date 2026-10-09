import { invoke } from "@tauri-apps/api/core";
import type { PluginHttpRequest, PluginHttpResponse, PluginScanResult } from "./types";

/**
 * 插件宿主命令的前端封装。
 *
 * 这一层只负责参数搬运与 URL 拼装，不做权限判断。
 *
 * 注意 `readPluginPackageFile` 及其后几个能力命令**当前没有调用方**：插件页面不在
 * capabilities 白名单内，调不到任何命令。保留封装是为了宿主注入受控桥后能直接复用，
 * 不必再回来补一遍参数搬运。
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
 * 插件页面资源的 URL 前缀缓存。
 *
 * 前缀只由平台决定、进程内不会变，缓存一次可以省掉每次打开插件窗口的一趟 IPC。
 * 失败时不写缓存，下次调用会重新尝试，而不是把一次失败固化成永久错误。
 */
let assetBaseUrl: string | null = null;

/**
 * 拼出插件入口页面的完整地址。
 *
 * 前缀由后端给出（Windows 上是 `http://plugin.localhost`），因为 WebView 对自定义协议的
 * 寻址方式跨平台不一致，这条判断只应该在 Rust 侧存在一份。
 */
export async function resolvePluginPageUrl(pluginId: string, entry: string): Promise<string> {
  assetBaseUrl ??= await invoke<string>("plugin_asset_base_url");

  return `${assetBaseUrl}/${encodeURIComponent(pluginId)}/${encodePagePath(entry)}`;
}

/**
 * 逐段编码页面路径。
 *
 * 刻意不用 `encodeURIComponent` 处理整串：它会把 `/` 一起编码成 `%2F`，把多段路径
 * 压成一段。页面里的相对链接（`./history.html`）是相对当前路径的目录解析的，压成
 * 一段之后它会丢掉插件 id，协议处理器就再也定位不到包目录。
 */
function encodePagePath(entry: string): string {
  return entry
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(encodeURIComponent)
    .join("/");
}

/**
 * 读取插件包内文本文件，对应 `fs:read` 能力。
 */
export function readPluginPackageFile(pluginId: string, relativePath: string): Promise<string> {
  return invoke<string>("read_plugin_package_file", { pluginId, relativePath });
}

/**
 * 写入插件包内文本文件，对应 `fs:write` 能力。
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
 * 代表插件发起 HTTP 请求。后端会强制超时与响应体体积上限，并记录请求与结果状态。
 *
 * 与插件页面里直接用 `fetch` 的区别是不受同源策略约束：浏览器发起的请求需要目标接口
 * 返回 CORS 头，而这条路径由宿主进程发起，没有这个限制。
 */
export function requestFromPlugin(
  pluginId: string,
  request: PluginHttpRequest,
): Promise<PluginHttpResponse> {
  return invoke<PluginHttpResponse>("plugin_http_request", { pluginId, request });
}

/**
 * 用系统资源管理器打开插件根目录。
 */
export function openPluginRoot(): Promise<void> {
  return invoke("open_plugin_root");
}
