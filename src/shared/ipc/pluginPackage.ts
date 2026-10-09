import { listen, type Event, type UnlistenFn } from "@tauri-apps/api/event";
import type { PluginNotificationPayload } from "@/entities/pluginPackage/types";

/**
 * 插件通知事件名，与后端 `PLUGIN_NOTIFICATION_EVENT` 保持一致。
 *
 * 目前没有插件能触发它——插件页面不在 capabilities 白名单内，调不到 `notify_from_plugin`。
 * 事件订阅与后端广播这条链路先留着，宿主注入受控桥之后即可直接复用。
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
