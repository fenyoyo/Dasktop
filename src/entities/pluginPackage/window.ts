import { emit } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { PLUGIN_HOST_SWITCH_EVENT } from "@/shared/ipc/pluginPackage";

/**
 * 插件宿主窗口。
 *
 * 单窗口承载所有插件：切换插件时只替换内容，而不是为每个插件各开一个窗口。
 * 这与实际使用方式相符——用户同一时刻只会看一个插件界面——也避免窗口数量
 * 随已安装插件数线性增长。
 */

/** 插件宿主窗口的标签，同时是 capabilities 白名单里的标识。 */
export const PLUGIN_HOST_WINDOW_LABEL = "plugin_host";

/** 插件宿主窗口的默认尺寸与下限。 */
const PLUGIN_HOST_WINDOW_SIZE = {
  height: 560,
  minHeight: 320,
  minWidth: 320,
  width: 420,
};

/**
 * 创建中的窗口 Promise，用于合并并发打开请求。
 *
 * 同一帧内两侧同时点「打开界面」时，没有这层共享会各建一次同名窗口，
 * 后建的必然失败。
 */
let pendingWindow: Promise<WebviewWindow> | null = null;

/**
 * 打开插件宿主窗口并切到指定插件。
 *
 * 窗口已存在时走事件通知它换插件，而不是重新创建：事件路径与 URL 路径分开的原因
 * 见 `PLUGIN_HOST_SWITCH_EVENT` 的注释。
 */
export async function openPluginHostWindow(pluginId: string, pluginName: string): Promise<void> {
  const existing = await WebviewWindow.getByLabel(PLUGIN_HOST_WINDOW_LABEL);
  const hostWindow = await ensurePluginHostWindow(pluginId, pluginName);

  if (existing) {
    await hostWindow.setTitle(resolveWindowTitle(pluginName));
    await emit(PLUGIN_HOST_SWITCH_EVENT, pluginId);
  }

  await hostWindow.show();
  await hostWindow.setFocus();
}

/**
 * 关闭插件宿主窗口。
 */
export async function closePluginHostWindow(): Promise<void> {
  const existing = await WebviewWindow.getByLabel(PLUGIN_HOST_WINDOW_LABEL);
  await existing?.close();
}

/**
 * 取回或创建插件宿主窗口。
 */
async function ensurePluginHostWindow(
  pluginId: string,
  pluginName: string,
): Promise<WebviewWindow> {
  const existing = await WebviewWindow.getByLabel(PLUGIN_HOST_WINDOW_LABEL);
  if (existing) {
    return existing;
  }

  if (!pendingWindow) {
    pendingWindow = createPluginHostWindow(pluginId, pluginName)
      .catch(async (error) => {
        // 并发创建时另一侧可能已抢先建成，兜底取回而不是把「已存在」当成失败抛给用户。
        const created = await WebviewWindow.getByLabel(PLUGIN_HOST_WINDOW_LABEL);
        if (created) {
          return created;
        }

        throw error;
      })
      .finally(() => {
        pendingWindow = null;
      });
  }

  return pendingWindow;
}

/**
 * 创建插件宿主窗口，插件身份通过 URL query 传入。
 */
async function createPluginHostWindow(
  pluginId: string,
  pluginName: string,
): Promise<WebviewWindow> {
  const searchParams = new URLSearchParams({ pluginHost: pluginId });

  return new Promise<WebviewWindow>((resolve, reject) => {
    const createdWindow = new WebviewWindow(PLUGIN_HOST_WINDOW_LABEL, {
      height: PLUGIN_HOST_WINDOW_SIZE.height,
      minHeight: PLUGIN_HOST_WINDOW_SIZE.minHeight,
      minWidth: PLUGIN_HOST_WINDOW_SIZE.minWidth,
      resizable: true,
      title: resolveWindowTitle(pluginName),
      url: `/?${searchParams.toString()}`,
      width: PLUGIN_HOST_WINDOW_SIZE.width,
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
