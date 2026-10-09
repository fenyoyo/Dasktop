import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { resolvePluginPageUrl } from "./api";

/**
 * 插件窗口。
 *
 * 每个插件一个窗口，标签形如 `plugin_<插件id>`。页面模式下插件就是一个网页，容器用
 * 「一个插件一个窗口」而不是「一个窗口换内容」：省掉跨窗口通知它换页面的那套事件握手，
 * 每个插件的页面状态也天然独立，切回来不会丢。
 *
 * 这些窗口**刻意不出现在任何 capability 里**。这道防线有两层，缺一不可：
 *
 * 1. 应用命令的鉴权**只有存在 app ACL manifest 时才生效**。Tauri 的判定是
 *    `plugin_command.is_some() || has_app_acl_manifest || !is_local`（见 tauri 的
 *    `webview/mod.rs`），而插件窗口的 `http://plugin.localhost` 会被 `is_local_url`
 *    判定为**本机来源**——三个条件里它只可能命中中间那个。所以 `src-tauri/permissions/`
 *    下的 app 权限定义是必需项，缺了它插件页面能无门控地调宿主任何一条命令。
 * 2. 有了 app ACL 之后，授权与否完全看 capability 的窗口模式是否匹配。这里一条都不给。
 *
 * 注意别写成「不给授权它就拿不到 `__TAURI_INTERNALS__`」——恰恰相反，那个注入脚本是加在
 * **每个** Tauri 创建的 webview 上的（`manager/webview.rs`），插件页面照样能调
 * `window.__TAURI_INTERNALS__.invoke(...)`，被拦下来靠的是上面这条 ACL，不是拿不到入口。
 */

/**
 * 插件窗口标签前缀。
 */
export const PLUGIN_WINDOW_LABEL_PREFIX = "plugin_";

/**
 * 插件窗口的默认尺寸与下限。
 *
 * 比原来的界面窗口大一圈：插件页面是网页，作者可能在里面排布多列内容，
 * 太窄会逼着他们为一个具体尺寸做适配。
 */
const PLUGIN_WINDOW_SIZE = {
  height: 640,
  minHeight: 360,
  minWidth: 420,
  width: 560,
};

/**
 * 创建中的窗口 Promise，按窗口标签合并并发打开请求。
 *
 * 同一帧内重复点击「打开」时，没有这层合并会各建一次同名窗口，后建的必然失败。
 */
const pendingWindows = new Map<string, Promise<WebviewWindow>>();

/**
 * 取插件对应的窗口标签。
 */
export function pluginWindowLabel(pluginId: string): string {
  return `${PLUGIN_WINDOW_LABEL_PREFIX}${pluginId}`;
}

/**
 * 打开插件的界面窗口；窗口已存在时直接聚焦，不重新创建。
 *
 * 已存在时不重新导航：用户在插件页面里可能已经翻到第二页，重载会把他弹回入口页面。
 */
export async function openPluginWindow(
  pluginId: string,
  pluginName: string,
  entry: string,
): Promise<void> {
  const label = pluginWindowLabel(pluginId);
  const existing = await WebviewWindow.getByLabel(label);

  if (existing) {
    await existing.show();
    await existing.setFocus();

    return;
  }

  const hostWindow = await ensurePluginWindow(label, pluginId, pluginName, entry);

  await hostWindow.show();
  await hostWindow.setFocus();
}

/**
 * 关闭插件窗口。
 */
export async function closePluginWindow(pluginId: string): Promise<void> {
  const existing = await WebviewWindow.getByLabel(pluginWindowLabel(pluginId));
  await existing?.close();
}

/**
 * 取回或创建插件窗口。
 *
 * 用 Map 而不是单个 Promise：多个插件可以同时被打开，它们之间没有理由互相阻塞。
 */
async function ensurePluginWindow(
  label: string,
  pluginId: string,
  pluginName: string,
  entry: string,
): Promise<WebviewWindow> {
  const pending = pendingWindows.get(label);
  if (pending) {
    return pending;
  }

  const created = createPluginWindow(label, pluginId, pluginName, entry)
    .catch(async (error) => {
      // 并发创建时另一侧可能已抢先建成，兜底取回而不是把「已存在」当成失败抛给用户。
      const existing = await WebviewWindow.getByLabel(label);
      if (existing) {
        return existing;
      }

      throw error;
    })
    .finally(() => {
      pendingWindows.delete(label);
    });

  pendingWindows.set(label, created);

  return created;
}

/**
 * 创建插件窗口，指向插件的入口页面。
 */
async function createPluginWindow(
  label: string,
  pluginId: string,
  pluginName: string,
  entry: string,
): Promise<WebviewWindow> {
  const url = await resolvePluginPageUrl(pluginId, entry);

  return new Promise<WebviewWindow>((resolve, reject) => {
    const createdWindow = new WebviewWindow(label, {
      height: PLUGIN_WINDOW_SIZE.height,
      minHeight: PLUGIN_WINDOW_SIZE.minHeight,
      minWidth: PLUGIN_WINDOW_SIZE.minWidth,
      resizable: true,
      title: resolveWindowTitle(pluginName),
      url,
      width: PLUGIN_WINDOW_SIZE.width,
    });

    void createdWindow.once("tauri://created", () => resolve(createdWindow));
    void createdWindow.once<unknown>("tauri://error", (error) => reject(error.payload));
  });
}

/**
 * 组合窗口标题，保留 Dasktop 前缀便于在任务栏识别。
 */
function resolveWindowTitle(pluginName: string): string {
  return `${pluginName} - Dasktop 插件`;
}
