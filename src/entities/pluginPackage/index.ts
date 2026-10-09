/**
 * 插件包框架的前端入口。
 *
 * 对外暴露三类内容：
 * - 运行时快照与生命周期函数（宿主面板使用）；
 * - 插件窗口的打开与关闭；
 * - 权限映射表与协议类型。
 */

export {
  appendPluginNotification,
  disposePluginRuntime,
  initializePluginRuntime,
  pluginRuntime,
  reloadPluginRuntime,
} from "./loader";

export {
  closePluginWindow,
  openPluginWindow,
  PLUGIN_WINDOW_LABEL_PREFIX,
  pluginWindowLabel,
} from "./window";

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
  type PluginHttpRequest,
  type PluginHttpResponse,
  type PluginNotificationPayload,
  type PluginPackageManifest,
  type PluginPackageRecord,
  type PluginPermission,
  type PluginRuntimeRecord,
  type PluginRuntimeSnapshot,
  type PluginRuntimeStatus,
  type PluginScanResult,
} from "./types";
