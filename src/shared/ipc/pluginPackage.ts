import { emit, listen, type Event, type UnlistenFn } from "@tauri-apps/api/event";
import type { PluginNotificationPayload, PluginUiNode } from "@/entities/pluginPackage/types";

/**
 * 插件通知事件名，与后端 `PLUGIN_NOTIFICATION_EVENT` 保持一致。
 *
 * 插件调用 `ui:notify` 能力时，后端广播该事件；宿主面板订阅它来展示通知流，
 * 事件与命令分开是为了让通知在界面上的呈现方式与插件调用方式解耦。
 */
export const PLUGIN_NOTIFICATION_EVENT = "dasktop://plugin-notification";

/**
 * 监听插件通知事件，载荷为该条通知的完整内容。
 */
export async function listenPluginNotification(
  handler: (event: Event<PluginNotificationPayload>) => void,
): Promise<UnlistenFn> {
  return listen<PluginNotificationPayload>(PLUGIN_NOTIFICATION_EVENT, handler);
}

/**
 * 插件宿主窗口的切换事件名，载荷为目标插件 id。
 *
 * 窗口已存在时靠该事件告知它改渲染哪个插件；首次打开则走 URL query。
 * 两条路径分开是为了避免依赖「窗口里的监听器是否已挂载」这一时序假设——
 * 刚创建完窗口就发事件，事件可能早于监听器注册而丢失。
 */
export const PLUGIN_HOST_SWITCH_EVENT = "dasktop://plugin-host-switch";

/**
 * 监听插件宿主窗口的切换事件。
 */
export async function listenPluginHostSwitch(
  handler: (event: Event<string>) => void,
): Promise<UnlistenFn> {
  return listen<string>(PLUGIN_HOST_SWITCH_EVENT, handler);
}

/**
 * 插件界面下发事件名，载荷为「插件 id + 界面描述树」。
 *
 * 必须走事件而不能共享内存的原因：Tauri 的每个窗口是独立 WebView，各自有独立的 JS
 * 环境。界面树产生于设置窗口（插件运行时所在窗口），而渲染发生在插件宿主窗口，
 * 后者读不到前者的模块级状态，只能靠事件把它送过去。
 */
export const PLUGIN_UI_RENDER_EVENT = "dasktop://plugin-ui-render";

/**
 * 界面下发载荷。
 */
export interface PluginUiRenderPayload {
  pluginId: string;
  tree: PluginUiNode;
}

/**
 * 广播一次插件界面下发。
 */
export function emitPluginUiRender(payload: PluginUiRenderPayload): Promise<void> {
  return emit(PLUGIN_UI_RENDER_EVENT, payload);
}

/**
 * 监听插件界面下发。
 */
export async function listenPluginUiRender(
  handler: (event: Event<PluginUiRenderPayload>) => void,
): Promise<UnlistenFn> {
  return listen<PluginUiRenderPayload>(PLUGIN_UI_RENDER_EVENT, handler);
}

/**
 * 插件宿主窗口就绪事件名，载荷为它当前要展示的插件 id。
 *
 * 新窗口创建后立刻补发界面树是不可靠的：事件可能早于窗口内监听器的注册。
 * 改由窗口挂载完成后主动报到，再由插件运行时所在窗口回发一次当前界面树，
 * 时序就从「猜」变成了「确定」。
 */
export const PLUGIN_HOST_READY_EVENT = "dasktop://plugin-host-ready";

/**
 * 广播「插件宿主窗口已就绪」。
 */
export function emitPluginHostReady(pluginId: string): Promise<void> {
  return emit(PLUGIN_HOST_READY_EVENT, pluginId);
}

/**
 * 监听「插件宿主窗口已就绪」。
 */
export async function listenPluginHostReady(
  handler: (event: Event<string>) => void,
): Promise<UnlistenFn> {
  return listen<string>(PLUGIN_HOST_READY_EVENT, handler);
}

/**
 * 插件界面交互事件名。
 *
 * 交互产生于插件宿主窗口，但插件的 Worker 活在设置窗口里——两个窗口各有独立 JS 环境，
 * 因此一次点击必须绕一圈事件才能送到插件手上，不能直接调用运行时函数。
 */
export const PLUGIN_UI_EVENT = "dasktop://plugin-ui-event";

/**
 * 界面交互载荷。
 */
export interface PluginUiEventPayload {
  /** 节点上声明的动作标识。 */
  action: string;
  /** 附加数据，例如输入框的提交内容。 */
  payload?: unknown;
  /** 目标插件 id。 */
  pluginId: string;
}

/**
 * 广播一次插件界面交互。
 */
export function emitPluginUiEvent(payload: PluginUiEventPayload): Promise<void> {
  return emit(PLUGIN_UI_EVENT, payload);
}

/**
 * 监听插件界面交互。
 */
export async function listenPluginUiEvent(
  handler: (event: Event<PluginUiEventPayload>) => void,
): Promise<UnlistenFn> {
  return listen<PluginUiEventPayload>(PLUGIN_UI_EVENT, handler);
}
