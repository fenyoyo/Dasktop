import { listen, type Event, type UnlistenFn } from "@tauri-apps/api/event";
import type { PluginNotificationPayload } from "@/entities/pluginPackage/types";

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
