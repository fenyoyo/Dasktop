import { PLUGIN_PERMISSIONS, type PluginPermission } from "./types";

/**
 * 权限映射记录：权限字符串到宿主命令的对应关系。
 *
 * 映射表是「权限 → 能力」的唯一事实来源：设置页展示插件权限时用它生成说明文案，
 * `scripts/verify-acl.mjs` 也用它推导「插件窗口该被授予哪些命令」——插件窗口的
 * capability 里多授权一条宿主命令，校验就会失败。所以这张表不只是文案。
 *
 * `command` 指向真实存在的 Rust 命令。它们由插件页面的能力桥调用，插件代码不经过
 * 前端这套代码；但「插件能调哪五条」这件事与「插件窗口被授予哪五条」必须是同一个集合，
 * 因此仍由本表统一表达。
 *
 * 判定落在两处，缺一不可：
 * - **窗口级**：capability 决定插件窗口能不能调这五条命令（ACL）；
 * - **插件级**：服务层读插件清单，决定这个插件声明过没有。
 *
 * ACL 的粒度是窗口，区分不了同样是插件窗口的 A 和 B，所以第二处必须自己判。
 */
export interface PluginPermissionDefinition {
  /** 该权限对应的宿主命令名。 */
  command: string;
  /** 权限字符串。 */
  permission: PluginPermission;
  /** 一句话说明该权限允许插件做什么。 */
  summary: string;
}

/**
 * 宿主开放的权限清单。
 */
export const PLUGIN_PERMISSION_DEFINITIONS: readonly PluginPermissionDefinition[] = [
  {
    command: "read_plugin_package_file",
    permission: "fs:read",
    summary: "读取插件包自身目录内的文本文件",
  },
  {
    command: "write_plugin_package_file",
    permission: "fs:write",
    summary: "写入插件包自身目录内的文本文件",
  },
  {
    command: "write_plugin_log",
    permission: "log:write",
    summary: "写入按插件隔离的运行日志",
  },
  {
    command: "plugin_http_request",
    permission: "net:request",
    summary: "发起 HTTP 请求（超时与响应体体积由宿主强制约束）",
  },
  {
    command: "notify_from_plugin",
    permission: "ui:notify",
    summary: "向宿主发送通知",
  },
];

/**
 * 判断字符串是否为宿主认识的权限。
 */
export function isKnownPluginPermission(value: string): value is PluginPermission {
  return PLUGIN_PERMISSIONS.some((permission) => permission === value);
}

/**
 * 清单权限的解析结果。
 */
export interface ResolvedPluginPermissions {
  /** 去重后按声明顺序排列的已知权限。 */
  granted: PluginPermission[];
  /** 宿主不认识、因而无法授予的权限字符串。 */
  unknown: string[];
}

/**
 * 把清单里的权限字符串拆成「已知」与「宿主不认识」两组。
 *
 * 不做静默过滤：未知权限必须被上报，由加载器决定拒绝加载。插件声明了宿主不认识的
 * 权限，说明它是按更新版本的宿主编写的，此时按「部分授权」把它放过去，用户会以为
 * 一切正常，直到某个功能静默失效才回来排查。
 */
export function resolvePluginPermissions(declared: readonly string[]): ResolvedPluginPermissions {
  const granted: PluginPermission[] = [];
  const unknown: string[] = [];

  for (const permission of declared) {
    if (!isKnownPluginPermission(permission)) {
      unknown.push(permission);
      continue;
    }

    if (!granted.includes(permission)) {
      granted.push(permission);
    }
  }

  return { granted, unknown };
}
