/**
 * 插件包框架的前端入口。
 *
 * 对外暴露三类内容：
 * - 运行时快照与生命周期函数（宿主面板使用）；
 * - 插件窗口的打开与关闭；
 * - 权限映射表与协议类型。
 *
 * 这里**没有**插件的 JavaScript SDK：插件页面跑在自己的窗口里，调用宿主能力走的是
 * 宿主注入的 `window.dasktop` 能力桥（见 `src-tauri/src/services/plugin/bridge.js`），
 * 与前端这套代码没有任何 import 关系。
 */

export {
  appendPluginNotification,
  disposePluginRuntime,
  initializePluginRuntime,
  pluginRuntime,
  reloadPluginHotkeys,
  reloadPluginRuntime,
  resetPluginWindowSize,
  savePluginHotkey,
  savePluginWindowSize,
} from "./loader";

export { closePluginWindow, PLUGIN_WINDOW_LABEL_PREFIX, pluginWindowLabel } from "./window";

export { listPlugins, openPluginRoot, openPluginWindow } from "./api";

export {
  PLUGIN_PERMISSION_DEFINITIONS,
  isKnownPluginPermission,
  resolvePluginPermissions,
  type PluginPermissionDefinition,
  type ResolvedPluginPermissions,
} from "./permissions";

export {
  PLUGIN_NOTIFICATION_LIMIT,
  PLUGIN_PERMISSIONS,
  PLUGIN_WINDOW_DEFAULT_SIZE,
  PLUGIN_WINDOW_SIZE_LIMITS,
  PLUGIN_WINDOW_SIZE_SOURCE_LABELS,
  type PluginNotificationPayload,
  type PluginPackageManifest,
  type PluginPackageRecord,
  type PluginPermission,
  type PluginHotkey,
  type PluginHotkeyRegistration,
  type PluginHotkeyStatus,
  type PluginRuntimeRecord,
  type PluginRuntimeSnapshot,
  type PluginRuntimeStatus,
  type PluginScanResult,
  type PluginWindowKind,
  type PluginWindowSize,
  type PluginWindowSizeSource,
  type PluginWindowSizeView,
} from "./types";
