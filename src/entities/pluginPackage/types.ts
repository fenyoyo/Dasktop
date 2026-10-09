/**
 * 插件包框架的类型定义。
 *
 * 分两组：
 * 1. **传输契约** —— 清单、扫描结果、通知载荷，与 Rust 侧结构逐字段对应；
 * 2. **运行时视图** —— 宿主面板消费的快照结构。
 *
 * 这里没有「插件需要实现的 TypeScript 接口」：插件页面是普通网页，用标准 Web API 与
 * 宿主注入的 `window.dasktop` 编写，不经过前端这套代码。宿主与插件之间的接口只有两样
 * ——目录结构（`plugin.json` + 页面文件）与那份能力桥。
 */

/* -------------------------------------------------------------------------- */
/* 传输契约                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 插件包清单，字段与插件包内 `plugin.json` 一一对应。
 *
 * `permissions` 保持 `string[]` 而不是窄化成权限联合类型：清单内容来自磁盘，
 * 不受宿主类型系统约束，窄化必须发生在运行期校验之后（见 `permissions.ts`）。
 */
export interface PluginPackageManifest {
  /** 入口页面相对插件包目录的路径，指向一份 HTML 文件。 */
  entry: string;
  id: string;
  name: string;
  permissions: string[];
  version: string;
}

/**
 * 扫描结果中的单个插件包记录。
 *
 * 清单损坏的包同样会返回，此时 `manifest` 为 null 且 `error` 说明原因，
 * 宿主面板据此显示「为什么不加载」而不是静默忽略该目录。
 */
export interface PluginPackageRecord {
  directoryPath: string;
  error: string | null;
  id: string;
  manifest: PluginPackageManifest | null;
}

/**
 * 插件扫描结果，携带根目录供宿主面板展示插件安装位置。
 */
export interface PluginScanResult {
  packages: PluginPackageRecord[];
  rootPath: string;
}

/**
 * 插件通知载荷。
 *
 * 由插件经 `ui:notify` 能力触发，宿主广播给界面，插件面板据此展示通知流。
 */
export interface PluginNotificationPayload {
  createdAt: number;
  message: string;
  pluginId: string;
  title: string;
}

/**
 * 宿主当前能够授予插件的权限。
 *
 * 字符串统一采用 `领域:动作` 格式。这份清单有四处用途，改一处必须同时改其余几处：
 *
 * 1. 拒绝加载声明了未知权限的包（把「按更高版本宿主编写的插件」在加载期挡住）；
 * 2. 插件窗口的能力桥按它决定挂载哪些方法（`services/plugin/bridge.rs`）；
 * 3. Rust 侧每条能力命令执行前查插件清单（`services/plugin/mod.rs`）；
 * 4. 插件窗口的 ACL 授权范围（`permissions/plugin-capabilities.toml`）。
 *
 * `scripts/verify-plugins.mjs` 会比对这里的集合与 Rust 侧的 `PLUGIN_PERMISSIONS`，
 * 以及本文件权限与宿主命令的映射（见 `permissions.ts`）。
 */
export const PLUGIN_PERMISSIONS = [
  "fs:read",
  "fs:write",
  "log:write",
  "net:request",
  "ui:notify",
] as const;

/**
 * 能力权限联合类型。
 */
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

/* -------------------------------------------------------------------------- */
/* 运行时视图                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 插件包在宿主里的可用状态。
 *
 * 只有两种：页面模式下插件不需要被「激活」，扫描通过就随时可以打开；`failed` 专指
 * 清单有问题、因而打不开的包。区分它们是为了让设置页能把「坏了」和「还没打开过」
 * 说清楚——后者不是一个需要提醒用户的状态。
 */
export type PluginRuntimeStatus = "failed" | "ready";

/**
 * 单个插件包的运行时记录。
 *
 * 记录同时承载「扫描结果」与「失败原因」：失败插件不会被移出列表，
 * 否则用户在设置页里看不到任何线索，只能怀疑宿主坏了。
 */
export interface PluginRuntimeRecord {
  /** 插件包绝对路径，便于用户对照磁盘排查。 */
  directoryPath: string;
  /** 入口页面文件名，从清单取得；清单不可用时为空字符串。 */
  entry: string;
  /** 未能就绪时的原因说明。 */
  error: string | null;
  /** 插件包目录名，同时也是清单 id。 */
  id: string;
  /** 插件展示名称，清单不可用时回退为 id。 */
  name: string;
  /** 清单声明且宿主认识的权限。 */
  permissions: readonly PluginPermission[];
  /** 可用性状态。 */
  status: PluginRuntimeStatus;
  /** 清单声明的、宿主不认识因而被拒绝的权限字符串。 */
  unknownPermissions: readonly string[];
  /** 插件版本号，清单不可用时为空字符串。 */
  version: string;
}

/**
 * 插件运行时快照，宿主面板直接消费该结构。
 */
export interface PluginRuntimeSnapshot {
  /** 扫描过程中的整体错误，例如插件目录不可读。 */
  error: string | null;
  /** 是否正在扫描，用于禁用面板上的重复触发按钮。 */
  loading: boolean;
  /** 按时间倒序保留的最近通知。 */
  notifications: readonly PluginNotificationPayload[];
  /** 插件包运行时记录，按 id 升序。 */
  records: readonly PluginRuntimeRecord[];
  /** 插件根目录绝对路径。 */
  rootPath: string;
}

/**
 * 宿主面板最多保留的通知条数。
 *
 * 通知只在当前会话内展示，不落库；上限用于防止插件高频通知时把内存吃满。
 */
export const PLUGIN_NOTIFICATION_LIMIT = 50;
