/**
 * 插件包框架的类型定义。
 *
 * 分两组：
 * 1. **传输契约** —— 清单、扫描结果、通知载荷，与 Rust 侧结构逐字段对应；
 * 2. **运行时视图** —— 宿主面板消费的快照结构。
 *
 * 这里刻意没有「插件需要实现的接口」：插件界面是插件窗口里的普通网页，用标准 Web API
 * 编写，宿主不为它提供任何 JavaScript SDK。宿主与插件之间唯一的接口就是目录结构——
 * 一个 `plugin.json` 加若干页面文件。
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
 * 插件通知载荷。当前没有插件能触发它——插件页面不在 capabilities 白名单内，
 * 调不到 `notify_from_plugin`；保留整条链路是为了宿主注入的受控桥能直接复用。
 */
export interface PluginNotificationPayload {
  createdAt: number;
  message: string;
  pluginId: string;
  title: string;
}

/**
 * 插件发起的 HTTP 请求描述，与 Rust 侧 `PluginHttpRequest` 逐字段对应。
 *
 * 只有 `url` 是必填项，让「取一个接口」这类常见调用写成一行。
 */
export interface PluginHttpRequest {
  /** 请求体，按 UTF-8 文本承载。 */
  body?: string;
  /** 请求头，键值均为字符串。 */
  headers?: Record<string, string>;
  /** 请求方法，缺省为 GET。 */
  method?: string;
  /** 目标地址，仅接受 http / https 协议。 */
  url: string;
}

/**
 * 插件 HTTP 请求结果。
 *
 * 非 2xx 不作为异常抛出：调用外部接口时 4xx 往往带有插件需要读取的说明正文，
 * 把它变成异常会迫使插件再发一次相同请求。
 */
export interface PluginHttpResponse {
  /** 响应体文本；非 UTF-8 内容已被有损转换。 */
  body: string;
  /** 响应头，同名头以逗号合并。 */
  headers: Record<string, string>;
  /** HTTP 状态码。 */
  status: number;
}

/**
 * 宿主当前能够授予插件的权限。
 *
 * 字符串统一采用 `领域:动作` 格式。这份清单目前只用于「拒绝加载声明了未知权限的包」，
 * 也就是把「按更高版本宿主编写的插件」在加载期挡住，而不是等它运行到某个调用点才失败。
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
