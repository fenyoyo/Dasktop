import { PLUGIN_PERMISSIONS, type PluginPermission } from "./types";

/**
 * 权限映射记录：权限字符串到宿主命令的对应关系。
 *
 * 映射表是「权限 → 能力」的唯一事实来源：设置页展示插件权限时用它生成说明文案，
 * 避免界面文案和真实能力各写一套。
 *
 * `command` 指向真实存在的 Rust 命令。这些命令当前没有调用方：插件窗口不在任何 capability
 * 里，所以插件页面的 invoke 会被 ACL 拒掉（拦住它的是 `src-tauri/permissions/` 的 app 权限
 * 定义 + capability 的窗口模式，不是「拿不到 invoke 入口」——注入脚本对每个 webview 都生效）。
 *
 * 这份映射是为受控桥准备的：届时按清单权限把页面请求分流到对应命令。但要记住**注入到页面的
 * 对象只是便利层**——插件完全可以换掉它、或绕过它直接构造一次 `__TAURI_INTERNALS__.invoke`，
 * 所以真正的判据只能落在 ACL 与宿主侧收到的请求上。
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
