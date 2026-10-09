/**
 * 插件包框架的类型定义。
 *
 * 分三组：
 * 1. **传输契约** —— 清单、扫描结果、通知载荷，与 Rust 侧结构逐字段对应；
 * 2. **协议接口** —— 插件入口模块与受控上下文的签名，也就是插件作者面对的 API；
 * 3. **运行时视图** —— 宿主面板消费的快照结构。
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
 * 插件通知载荷，由后端在插件调用 `ui:notify` 时广播，界面直接以其为展示记录。
 */
export interface PluginNotificationPayload {
  createdAt: number;
  message: string;
  pluginId: string;
  title: string;
}

/* -------------------------------------------------------------------------- */
/* 协议接口                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 宿主当前开放给插件的能力权限。
 *
 * 字符串统一采用 `领域:动作` 格式，新增能力只需在此追加一项并在权限映射表里补一条记录。
 */
export const PLUGIN_PERMISSIONS = ["fs:read", "fs:write", "log:write", "ui:notify"] as const;

/**
 * 能力权限联合类型。
 */
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

/**
 * 插件包内文件读写接口。
 *
 * 所有路径都是相对插件包目录的相对路径，宿主后端会再次校验其无法逃出包目录；
 * 插件既无法通过 `../` 访问宿主文件，也无法访问其它插件包。
 *
 * 两个方法都是可选的：只声明 `fs:write` 的插件拿不到 `read`，
 * 因此调用前必须做能力判定，而不是靠 try/catch 掩盖权限缺失。
 */
export interface PluginFsApi {
  /** 读取包内文本文件，需要 `fs:read` 权限。 */
  read?: (relativePath: string) => Promise<string>;
  /** 写入包内文本文件，目录不存在时自动创建，需要 `fs:write` 权限。 */
  write?: (relativePath: string, contents: string) => Promise<void>;
}

/**
 * 插件日志接口，整体由 `log:write` 权限门控。
 */
export interface PluginLogApi {
  /** 按自定义级别记录一条日志。 */
  write: (message: string, level?: string) => Promise<void>;
  /** 以 `info` 级别记录一条日志。 */
  info: (message: string) => Promise<void>;
  /** 以 `error` 级别记录一条日志。 */
  error: (message: string) => Promise<void>;
}

/**
 * 通知接口签名，需要 `ui:notify` 权限。
 */
export type PluginNotifyApi = (title: string, message: string) => Promise<void>;

/**
 * 受控 API 上下文，也就是插件的 `activate(host)` 参数。
 *
 * 设计要点是「按权限裁剪」：清单未声明 `ui:notify` 时 `notify` 成员根本不存在，
 * 插件拿不到一个「存在但会抛错」的方法，因此无法用 try/catch 掩盖权限缺失。
 * 三个能力分组都声明为可选，插件侧必须先做能力判定再调用。
 *
 * 上下文里刻意不提供 `invoke`：插件要触达宿主能力只能走这里暴露的方法，
 * 而每个方法进入宿主前都会再做一次权限校验。
 */
export interface PluginHostApi {
  /** 宿主版本号，插件可用于提示自身适配范围。 */
  readonly hostVersion: string;
  /** 本插件声明的、经宿主校验通过的能力权限。 */
  readonly permissions: readonly PluginPermission[];
  /** 插件唯一标识，同时也是包目录名。 */
  readonly pluginId: string;
  /** 插件版本号，取自清单。 */
  readonly pluginVersion: string;
  /** 包内文件读写，仅声明 `fs:read` / `fs:write` 时存在。 */
  readonly fs?: PluginFsApi;
  /** 插件日志，仅声明 `log:write` 时存在。 */
  readonly log?: PluginLogApi;
  /** 宿主通知，仅声明 `ui:notify` 时存在。 */
  readonly notify?: PluginNotifyApi;
}

/**
 * 插件入口模块必须实现的最小接口。
 *
 * `activate` 缺失时宿主拒绝加载；`deactivate` 可选，卸载时调用。
 * 两者都允许返回 Promise，宿主会等待其完成再继续，方便插件做异步初始化与收尾。
 */
export interface PluginModule {
  /** 宿主加载并激活插件时调用。 */
  activate(host: PluginHostApi): void | Promise<void>;
  /** 宿主卸载插件时调用，用于释放插件自己申请的资源。 */
  deactivate?(host: PluginHostApi): void | Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* 运行时视图                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 插件运行时状态。
 *
 * `unloaded` 与 `failed` 分开表达：「插件被正常卸载」和「插件加载报错」在面板上
 * 需要给出完全不同的提示，混用一个状态会让用户误以为插件坏了。
 */
export type PluginRuntimeStatus = "loaded" | "failed" | "unloaded";

/**
 * 单个插件包的运行时记录。
 *
 * 记录同时承载「加载结果」与「失败原因」：失败插件不会被移出列表，
 * 否则用户在设置页里看不到任何线索，只能怀疑宿主坏了。
 */
export interface PluginRuntimeRecord {
  /** 插件包绝对路径，便于用户对照磁盘排查。 */
  directoryPath: string;
  /** 未加载成功时的原因说明。 */
  error: string | null;
  /** 插件包目录名，同时也是清单 id。 */
  id: string;
  /** 激活完成时间（毫秒时间戳），未加载成功时为 0。 */
  loadedAt: number;
  /** 插件展示名称，清单不可用时回退为 id。 */
  name: string;
  /** 宿主实际授予的能力权限。 */
  permissions: readonly PluginPermission[];
  /** 加载结果。 */
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
  /** 加载过程中的整体错误，例如插件目录不可读。 */
  error: string | null;
  /** 是否正在加载，用于禁用面板上的重复触发按钮。 */
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
 * 通知只在当前会话内展示，不落库；上限用于防止插件高频调用 `ui:notify` 时把内存吃满。
 */
export const PLUGIN_NOTIFICATION_LIMIT = 50;
