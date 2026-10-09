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
export const PLUGIN_PERMISSIONS = [
  "fs:read",
  "fs:write",
  "log:write",
  "net:request",
  "ui:notify",
  "ui:panel",
] as const;

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
 * 网络请求接口，整体由 `net:request` 权限门控。
 *
 * 宿主不做域名白名单（粒度选择为「仅权限门控」），因此插件一旦声明该权限
 * 即可访问任意 http / https 地址；超时与响应体体积仍由宿主强制约束。
 */
export interface PluginNetApi {
  /** 发起一次 HTTP 请求，返回状态码、响应头与响应体文本。 */
  request: (request: PluginHttpRequest) => Promise<PluginHttpResponse>;
}

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
  /** 网络请求，仅声明 `net:request` 时存在。 */
  readonly net?: PluginNetApi;
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

/* -------------------------------------------------------------------------- */
/* Worker 通信协议                                                             */
/* -------------------------------------------------------------------------- */

/**
 * 下发给插件 Worker 的身份与授权配置。
 *
 * 只包含可结构化克隆的基本类型：Worker 边界上不能传函数或类实例。
 */
export interface PluginWorkerConfig {
  /** 宿主版本号。 */
  hostVersion: string;
  /** 经加载期预检后实际授予的权限。 */
  permissions: readonly PluginPermission[];
  /** 插件唯一标识。 */
  pluginId: string;
  /** 插件版本号。 */
  pluginVersion: string;
}

/**
 * 主线程发给插件 Worker 的消息。
 *
 * `rpc-result` 是宿主能力调用的回执，其余是生命周期与界面交互指令。
 */
export type PluginWorkerInbound =
  | { kind: "init"; config: PluginWorkerConfig }
  | { id: number; kind: "rpc-result"; ok: true; value: unknown }
  | { error: string; id: number; kind: "rpc-result"; ok: false }
  | { kind: "deactivate" }
  | { action: string; kind: "ui-event"; payload?: unknown };

/**
 * 插件 Worker 发给主线程的消息。
 *
 * `rpc` 承载「插件想调用某项宿主能力」的意图；真正的权限校验发生在主线程，
 * Worker 侧发出的请求一律按不可信输入处理。
 */
export type PluginWorkerOutbound =
  | { args: unknown[]; id: number; kind: "rpc"; method: string }
  | { kind: "activated" }
  | { kind: "deactivated" }
  | { message: string; kind: "error" }
  /** 插件下发的声明式界面描述，由宿主渲染成真实 DOM。 */
  | { kind: "ui-render"; tree: PluginUiNode };

/* -------------------------------------------------------------------------- */
/* 声明式 UI 协议                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 插件界面节点。
 *
 * 刻意设计成「可序列化的纯数据」而不是 HTML 字符串：插件永远无法制造内联脚本、
 * 内联样式或事件属性，宿主渲染器是唯一决定「什么能变成 DOM」的地方。
 */
export type PluginUiNode =
  | PluginUiText
  | PluginUiButton
  | PluginUiInput
  | PluginUiStack
  | PluginUiCard
  | PluginUiList
  | PluginUiKeyValue;

/** 行内纯文本。 */
export interface PluginUiText {
  /** 视觉强度，缺省为常规正文。 */
  tone?: "muted" | "normal" | "strong";
  type: "text";
  value: string;
}

/** 按钮；点击后宿主把 `action` 回传给插件。 */
export interface PluginUiButton {
  /** 回传给插件的动作标识。 */
  action: string;
  label: string;
  /** 视觉风格，缺省为默认按钮。 */
  tone?: "danger" | "default" | "primary";
  type: "button";
}

/**
 * 单行输入框。
 *
 * 内容**提交时**（回车或失焦）才回传 `action`，而不是每次按键都回传：
 * 逐键往返会让插件重渲染整棵树，输入框随之重建，光标位置也会丢。
 */
export interface PluginUiInput {
  action: string;
  label?: string;
  placeholder?: string;
  type: "input";
  value?: string;
}

/** 纵向或横向排列的容器。 */
export interface PluginUiStack {
  children: PluginUiNode[];
  direction: "column" | "row";
  /** 子节点间距，取有限档位而不是任意像素值。 */
  gap?: "lg" | "md" | "none" | "sm";
  type: "stack";
}

/** 带标题的卡片容器。 */
export interface PluginUiCard {
  children: PluginUiNode[];
  title?: string;
  type: "card";
}

/** 纯文本列表。 */
export interface PluginUiList {
  items: string[];
  type: "list";
}

/** 键值对表格，用于展示接口返回的字段。 */
export interface PluginUiKeyValue {
  entries: { key: string; value: string }[];
  type: "key-value";
}

