/**
 * 插件包框架的前端入口。
 *
 * 对外暴露三类内容：
 * - 运行时快照与生命周期函数（宿主面板使用）；
 * - 权限映射表（面板展示与后续文档生成使用）；
 * - 协议类型（插件作者参考）。
 *
 * 受控上下文的构建函数刻意不导出：它是安全边界，只允许加载器在激活插件时调用，
 * 任何其它模块拿到它都可能构建出一个绕过权限预检的上下文。
 */

export {
  appendPluginNotification,
  disposePluginRuntime,
  initializePluginRuntime,
  pluginRuntime,
  pluginUiTrees,
  reloadPluginRuntime,
  sendPluginUiEvent,
  unloadAllPlugins,
  unloadPlugin,
} from "./loader";

export { closePluginHostWindow, openPluginHostWindow, PLUGIN_HOST_WINDOW_LABEL } from "./window";

export {
  PLUGIN_PERMISSION_DEFINITIONS,
  assertPluginPermission,
  isKnownPluginPermission,
  resolvePluginPermissions,
  type PluginPermissionDefinition,
  type ResolvedPluginPermissions,
} from "./permissions";

export {
  PLUGIN_NOTIFICATION_LIMIT,
  PLUGIN_PERMISSIONS,
  type PluginFsApi,
  type PluginHostApi,
  type PluginHttpRequest,
  type PluginHttpResponse,
  type PluginLogApi,
  type PluginModule,
  type PluginNetApi,
  type PluginNotificationPayload,
  type PluginNotifyApi,
  type PluginPackageManifest,
  type PluginPackageRecord,
  type PluginPermission,
  type PluginRuntimeRecord,
  type PluginRuntimeSnapshot,
  type PluginRuntimeStatus,
  type PluginScanResult,
  type PluginUiNode,
  type PluginWorkerConfig,
} from "./types";
