import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

/**
 * 插件窗口的标识与关闭。
 *
 * 每个插件一个窗口，标签形如 `plugin_<插件id>`。用「一个插件一个窗口」而不是
 * 「一个窗口换内容」：省掉跨窗口通知它换页面的那套事件握手，每个插件的页面状态也天然
 * 独立，切回来不会丢。
 *
 * **这个标签同时是插件身份的锚点，不能只当命名约定看**。能力命令从调用方窗口的标签
 * 反推插件 id，插件自己填的 `plugin_id` 参数不被采纳——插件页面改不了自己的标签
 * （改标签要 `core:window` 权限，而插件窗口一条 Tauri 权限都没有）。与 Rust 侧
 * `domain/plugin/contract.rs` 的 `PLUGIN_WINDOW_LABEL_PREFIX` 必须一致。
 *
 * 打开窗口的动作不在这里，见 `api.ts` 的 `openPluginWindow`：窗口由 Rust 创建，
 * 因为能力桥只能在建窗时注入。
 *
 * 插件窗口的授权范围见 `src-tauri/capabilities/plugin.json`——它只拿得到五条能力命令，
 * 桌面 / Box / 工作区那些宿主命令一条都没有。这两份 capability 的命令集合必须保持
 * 不相交，`pnpm verify:acl` 会守住这一点。
 */

/**
 * 插件窗口标签前缀。
 */
export const PLUGIN_WINDOW_LABEL_PREFIX = "plugin_";

/**
 * 取插件对应的窗口标签。
 */
export function pluginWindowLabel(pluginId: string): string {
  return `${PLUGIN_WINDOW_LABEL_PREFIX}${pluginId}`;
}

/**
 * 关闭插件窗口；窗口不存在时什么也不做。
 *
 * 这里走的是 Tauri 自带的窗口 API 而不是宿主命令：关闭窗口是调用方窗口（设置窗）
 * 自己的权限，与插件能力无关。
 */
export async function closePluginWindow(pluginId: string): Promise<void> {
  const existing = await WebviewWindow.getByLabel(pluginWindowLabel(pluginId));

  await existing?.close();
}
