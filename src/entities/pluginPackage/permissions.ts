import { PLUGIN_PERMISSIONS, type PluginPermission } from "./types";

/**
 * 权限门控层的核心数据结构：权限字符串到宿主能力的映射记录。
 *
 * 映射表是「权限 → 能力」的唯一事实来源：上下文构建时据此决定暴露哪些方法，
 * 设置页展示插件权限时也复用同一份描述，避免界面文案和真实能力各写一套。
 */
export interface PluginPermissionDefinition {
  /** 该权限在受控上下文里暴露的位置，用于界面和文档标注。 */
  hostMember: string;
  /** 权限字符串。 */
  permission: PluginPermission;
  /** 一句话说明该权限允许插件做什么。 */
  summary: string;
}

/**
 * 宿主开放的权限清单。
 *
 * 每一项都必须对应一个真实存在的宿主命令；新增能力时的顺序是
 * 「后端加命令 → 这里加映射 → 上下文加方法」，本表始终是最后落地的声明。
 */
export const PLUGIN_PERMISSION_DEFINITIONS: readonly PluginPermissionDefinition[] = [
  {
    hostMember: "host.fs.read",
    permission: "fs:read",
    summary: "读取插件包自身目录内的文本文件",
  },
  {
    hostMember: "host.fs.write",
    permission: "fs:write",
    summary: "写入插件包自身目录内的文本文件",
  },
  {
    hostMember: "host.log",
    permission: "log:write",
    summary: "写入按插件隔离的运行日志",
  },
  {
    hostMember: "host.net",
    permission: "net:request",
    summary: "发起 HTTP 请求（超时与响应体体积由宿主强制约束）",
  },
  {
    hostMember: "host.notify",
    permission: "ui:notify",
    summary: "向宿主发送通知",
  },
  {
    hostMember: "host.ui.render",
    permission: "ui:panel",
    summary: "下发布局描述，由宿主渲染到插件宿主窗口",
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
 * 把清单里的权限字符串拆成「可授予」与「宿主不认识」两组。
 *
 * 不做静默过滤：未知权限必须被上报，由加载器决定拒绝加载，
 * 否则插件会带着「以为已授权」的假设继续运行，直到调用点才失败，排查成本更高。
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

/**
 * 二次权限校验。
 *
 * 上下文构建阶段已经按权限裁剪过方法，这里仍然再查一次：插件可以通过保留早期的
 * 方法引用、或者滥用动态调用绕过成员裁剪，只有在每次调用时都校验才能保证
 * 「权限集合」始终是唯一判据。
 *
 * @param granted 该插件被授予的权限集合。
 * @param required 当前调用所需权限。
 * @param pluginId 插件 id，仅用于生成可定位的错误信息。
 */
export function assertPluginPermission(
  granted: ReadonlySet<PluginPermission>,
  required: PluginPermission,
  pluginId: string,
): void {
  if (granted.has(required)) {
    return;
  }

  throw new Error(`插件 ${pluginId} 未声明权限 ${required}，操作已被拒绝`);
}
