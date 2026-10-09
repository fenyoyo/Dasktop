import {
  notifyFromPlugin,
  readPluginPackageFile,
  requestFromPlugin,
  writePluginLog,
  writePluginPackageFile,
} from "./api";
import { assertPluginPermission } from "./permissions";
import type { PluginHttpRequest, PluginPermission } from "./types";

/**
 * 主线程侧的宿主能力桥。
 *
 * 这是**权限校验唯一真实生效的地方**。插件代码跑在 Web Worker 里，它持有的那份
 * `host` 对象只是便利层——插件完全可以替换掉它、或者直接 `postMessage` 一条伪造的
 * RPC。因此判定「这个插件能不能读文件」的依据只能是这里收到的 `method` 字符串
 * 与宿主自己保存的授权集合，绝不能相信 Worker 侧的任何自述。
 *
 * 与改造前的区别：旧实现把校验放在插件直接调用的对象方法里，插件与宿主同线程、
 * 同全局环境，理论上能绕过；现在插件连 `window` 都拿不到，触达宿主的入口只有
 * Worker 的消息通道，而这条通道的每个分支都会校验一次。
 */

/**
 * 构建宿主能力桥所需的输入。
 */
export interface CreatePluginHostBridgeOptions {
  /** 经加载期预检后实际授予的权限。 */
  permissions: readonly PluginPermission[];
  /** 插件唯一标识，同时作为所有宿主调用的归属标识。 */
  pluginId: string;
}

/**
 * 宿主能力桥，由 Worker 宿主在收到 `rpc` 消息时调用。
 */
export interface PluginHostBridge {
  /**
   * 处理一次来自插件 Worker 的能力调用。
   *
   * 返回值必须可结构化克隆——它要跨 Worker 边界送回插件侧。
   */
  handle: (method: string, args: unknown[]) => Promise<unknown>;
}

/**
 * 构建宿主能力桥。
 */
export function createPluginHostBridge(
  options: CreatePluginHostBridgeOptions,
): PluginHostBridge {
  const { permissions, pluginId } = options;
  const granted = new Set<PluginPermission>(permissions);

  return {
    handle: async (method, args) => {
      switch (method) {
        case "fs.read": {
          assertPluginPermission(granted, "fs:read", pluginId);

          return readPluginPackageFile(pluginId, asString(args[0], "path"));
        }

        case "fs.write": {
          assertPluginPermission(granted, "fs:write", pluginId);

          return writePluginPackageFile(
            pluginId,
            asString(args[0], "path"),
            asString(args[1], "contents"),
          );
        }

        case "log.write": {
          assertPluginPermission(granted, "log:write", pluginId);

          const level = args[1] === undefined ? "info" : asString(args[1], "level");

          return writePluginLog(pluginId, level, asString(args[0], "message"));
        }

        case "net.request": {
          assertPluginPermission(granted, "net:request", pluginId);

          return requestFromPlugin(pluginId, asHttpRequest(args[0]));
        }

        case "notify": {
          assertPluginPermission(granted, "ui:notify", pluginId);

          return notifyFromPlugin(
            pluginId,
            asString(args[0], "title"),
            asString(args[1], "message"),
          );
        }

        default:
          throw new Error(`插件 ${pluginId} 调用了未知的宿主能力：${method}`);
      }
    },
  };
}

/**
 * 校验并取出字符串参数。
 *
 * Worker 侧传来的参数一律按不可信输入处理：不做这层校验的话，一个类型错误会被
 * 一路带到 Rust 命令层，最终以 serde 反序列化失败的形式出现，排查时很难定位到插件。
 */
function asString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`宿主能力调用参数 ${label} 必须是字符串`);
  }

  return value;
}

/**
 * 校验并归一化网络请求参数。
 *
 * 刻意只挑出已知字段而不是整体透传：插件可以往对象里塞任意键，
 * 透传等于把「请求长什么样」的决定权交回给了插件。
 */
function asHttpRequest(value: unknown): PluginHttpRequest {
  if (typeof value !== "object" || value === null) {
    throw new Error("net.request 的参数必须是请求对象");
  }

  const candidate = value as Partial<PluginHttpRequest>;

  if (typeof candidate.url !== "string") {
    throw new Error("net.request 缺少字符串类型的 url");
  }

  return {
    body: typeof candidate.body === "string" ? candidate.body : undefined,
    headers: isStringRecord(candidate.headers) ? candidate.headers : undefined,
    method: typeof candidate.method === "string" ? candidate.method : undefined,
    url: candidate.url,
  };
}

/**
 * 判断值是否为「字符串到字符串」的普通记录。
 */
function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === "string");
}
