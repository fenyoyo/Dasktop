import {
  notifyFromPlugin,
  readPluginPackageFile,
  writePluginLog,
  writePluginPackageFile,
} from "./api";
import { assertPluginPermission } from "./permissions";
import type {
  PluginFsApi,
  PluginHostApi,
  PluginLogApi,
  PluginNotifyApi,
  PluginPermission,
} from "./types";

/**
 * 构建受控上下文所需的输入。
 */
export interface CreatePluginHostOptions {
  /** 宿主版本号，透传给插件用于提示适配范围。 */
  hostVersion: string;
  /** 经加载期预检后实际授予的权限。 */
  permissions: readonly PluginPermission[];
  /** 插件唯一标识，同时作为所有宿主调用的归属标识。 */
  pluginId: string;
  /** 插件版本号，取自清单。 */
  pluginVersion: string;
}

/**
 * 构建插件的受控 API 上下文。
 *
 * 这是安全边界的核心：返回对象上只有「清单已声明权限」对应的成员，
 * 且每个成员在真正触达宿主命令前都会再做一次权限校验。
 * 上下文里没有 `invoke`、没有任何 Tauri 句柄，插件无法绕过本层直接调用宿主命令。
 *
 * 需要特别注意：本层的门控强度依赖于「插件拿不到原始 invoke」这一前提。
 * 插件与宿主同线程运行，理论上仍可通过 `window` 触及宿主注入的全局对象，
 * 彻底封堵需要把插件迁到 Web Worker，见 `docs/plugin-package-framework.md` 的局限章节。
 */
export function createPluginHost(options: CreatePluginHostOptions): PluginHostApi {
  const { hostVersion, permissions, pluginId, pluginVersion } = options;
  const granted = new Set<PluginPermission>(permissions);

  const host: {
    fs?: PluginFsApi;
    hostVersion: string;
    log?: PluginLogApi;
    notify?: PluginNotifyApi;
    permissions: readonly PluginPermission[];
    pluginId: string;
    pluginVersion: string;
  } = {
    hostVersion,
    // 复制一份而不是把 Set 直接给出去：插件通过它反查权限集合时不应该拿到可变引用。
    permissions: [...permissions],
    pluginId,
    pluginVersion,
  };

  if (granted.has("fs:read") || granted.has("fs:write")) {
    host.fs = createGuardedFsApi(pluginId, granted);
  }

  if (granted.has("log:write")) {
    host.log = createGuardedLogApi(pluginId, granted);
  }

  if (granted.has("ui:notify")) {
    host.notify = createGuardedNotifyApi(pluginId, granted);
  }

  return host;
}

/**
 * 按权限逐方法裁剪包内文件读写能力。
 */
function createGuardedFsApi(
  pluginId: string,
  granted: ReadonlySet<PluginPermission>,
): PluginFsApi {
  const api: PluginFsApi = {};

  if (granted.has("fs:read")) {
    api.read = async (relativePath: string) => {
      assertPluginPermission(granted, "fs:read", pluginId);

      return readPluginPackageFile(pluginId, relativePath);
    };
  }

  if (granted.has("fs:write")) {
    api.write = async (relativePath: string, contents: string) => {
      assertPluginPermission(granted, "fs:write", pluginId);

      return writePluginPackageFile(pluginId, relativePath, contents);
    };
  }

  return api;
}

/**
 * 构建插件日志接口。
 */
function createGuardedLogApi(
  pluginId: string,
  granted: ReadonlySet<PluginPermission>,
): PluginLogApi {
  const append = async (message: string, level: string) => {
    assertPluginPermission(granted, "log:write", pluginId);

    return writePluginLog(pluginId, level, message);
  };

  return {
    error: (message: string) => append(message, "error"),
    info: (message: string) => append(message, "info"),
    write: (message: string, level = "info") => append(message, level),
  };
}

/**
 * 构建通知接口。
 */
function createGuardedNotifyApi(
  pluginId: string,
  granted: ReadonlySet<PluginPermission>,
): PluginNotifyApi {
  return async (title: string, message: string) => {
    assertPluginPermission(granted, "ui:notify", pluginId);

    return notifyFromPlugin(pluginId, title, message);
  };
}
