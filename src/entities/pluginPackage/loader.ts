import { readonly, shallowRef } from "vue";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { APP_META } from "@/shared/config/appMeta";
import { listenPluginNotification } from "@/shared/ipc/pluginPackage";
import { listPlugins, readPluginEntry } from "./api";
import { createPluginHost } from "./context";
import { resolvePluginPermissions } from "./permissions";
import {
  PLUGIN_NOTIFICATION_LIMIT,
  type PluginHostApi,
  type PluginModule,
  type PluginNotificationPayload,
  type PluginPackageRecord,
  type PluginRuntimeRecord,
  type PluginRuntimeSnapshot,
} from "./types";

/**
 * 已激活插件表，key 为插件 id。
 *
 * 表里保存的是「模块 + 上下文」这一对：卸载时需要把当初构建的上下文原样交回
 * `deactivate`，插件才能用它释放自己申请的资源。
 */
interface ActivePlugin {
  host: PluginHostApi;
  module: PluginModule;
}

const activePlugins = new Map<string, ActivePlugin>();

/**
 * 运行时快照。用 `shallowRef` 而不是 `reactive`：快照整体替换，
 * 深层响应式只会让插件记录数组被无谓地代理一遍。
 */
const snapshot = shallowRef<PluginRuntimeSnapshot>({
  error: null,
  loading: false,
  notifications: [],
  records: [],
  rootPath: "",
});

/**
 * 只读运行时快照，宿主面板据此渲染插件列表与通知流。
 */
export const pluginRuntime = readonly(snapshot);

/**
 * 初始化共享同一个 Promise。
 *
 * 宿主启动编排和用户手动「重新加载」可能同时触发，共享 Promise 是保证
 * 插件 `activate` 只被调用一次的最简手段；否则同一次启动会激活两遍插件，
 * 插件里任何按次累加的状态都会被写坏。
 */
let initializationPromise: Promise<void> | null = null;

/**
 * 通知事件订阅句柄，用于避免重复订阅与释放时漏退订。
 */
let notificationUnlisten: UnlistenFn | null = null;

/**
 * 首次调用时扫描并激活全部插件包；重复调用复用同一次初始化。
 */
export async function initializePluginRuntime(): Promise<void> {
  if (!initializationPromise) {
    initializationPromise = loadPluginPackages();
  }

  return initializationPromise;
}

/**
 * 卸载全部插件后重新扫描并激活，供宿主面板的「重新加载」使用。
 */
export async function reloadPluginRuntime(): Promise<void> {
  await unloadAllPlugins();

  initializationPromise = loadPluginPackages();

  return initializationPromise;
}

/**
 * 卸载单个插件。
 *
 * 先把它从已激活表里摘掉再调用 `deactivate`：插件在收尾过程中再次触发加载流程时，
 * 不会被误判成「已经激活」而直接跳过。
 */
export async function unloadPlugin(pluginId: string): Promise<void> {
  const active = activePlugins.get(pluginId);
  if (!active) {
    return;
  }

  activePlugins.delete(pluginId);

  try {
    await active.module.deactivate?.(active.host);
  } catch (error) {
    // 卸载失败不应阻塞其它插件，也不应该让宿主崩在一个第三方收尾逻辑上。
    console.error(`[plugin] ${pluginId} 卸载失败`, error);
  }

  updateSnapshot({
    records: snapshot.value.records.map((record) =>
      record.id === pluginId
        ? { ...record, error: null, loadedAt: 0, permissions: [], status: "unloaded" as const }
        : record,
    ),
  });
}

/**
 * 卸载全部已激活插件。
 */
export async function unloadAllPlugins(): Promise<void> {
  for (const pluginId of [...activePlugins.keys()]) {
    await unloadPlugin(pluginId);
  }
}

/**
 * 释放宿主级订阅，供应用级收尾与开发热更新使用。
 *
 * 热更新会重新执行本模块，如果不退订，旧模块持有的监听器会继续append 到已被替换的快照上。
 */
export function disposePluginRuntime(): void {
  notificationUnlisten?.();
  notificationUnlisten = null;
  initializationPromise = null;
  activePlugins.clear();
}

/**
 * 记录一条插件通知。
 */
export function appendPluginNotification(payload: PluginNotificationPayload): void {
  updateSnapshot({
    notifications: [payload, ...snapshot.value.notifications].slice(0, PLUGIN_NOTIFICATION_LIMIT),
  });
}

/**
 * 扫描插件目录并逐个激活插件包。
 *
 * 本函数不向外抛错：扫描整体失败会被写进快照的 `error` 字段，
 * 调用方（启动编排）不需要为「插件加载失败」单独写错误处理，也不会因此中断宿主启动。
 */
async function loadPluginPackages(): Promise<void> {
  updateSnapshot({ error: null, loading: true });

  try {
    await ensureNotificationListener();

    const scan = await listPlugins();
    const records: PluginRuntimeRecord[] = [];

    // 逐包串行激活而不是并发：插件激活通常包含文件读写，串行能让日志顺序与列表顺序一致，
    // 也更符合「插件数量是十几个量级」的实际规模。
    for (const packageRecord of scan.packages) {
      records.push(await activatePluginPackage(packageRecord));
    }

    updateSnapshot({ error: null, loading: false, records, rootPath: scan.rootPath });
  } catch (error) {
    updateSnapshot({ error: describeError(error), loading: false });
  }
}

/**
 * 激活单个插件包，返回其运行时记录。
 *
 * 所有失败路径都返回记录而不是抛错，保证一个坏插件不影响同批次其它插件。
 */
async function activatePluginPackage(
  packageRecord: PluginPackageRecord,
): Promise<PluginRuntimeRecord> {
  const base: PluginRuntimeRecord = {
    directoryPath: packageRecord.directoryPath,
    error: null,
    id: packageRecord.id,
    loadedAt: 0,
    name: packageRecord.manifest?.name ?? packageRecord.id,
    permissions: [],
    status: "failed",
    unknownPermissions: [],
    version: packageRecord.manifest?.version ?? "",
  };

  if (!packageRecord.manifest) {
    return { ...base, error: packageRecord.error ?? "插件清单不可用" };
  }

  const { granted, unknown } = resolvePluginPermissions(packageRecord.manifest.permissions);

  // 加载期预检：声明了宿主不认识的能力，说明该插件是按更高版本宿主编写的。
  // 直接拒绝加载而不是忽略未知权限，否则插件会带着「以为已授权」的假设运行到调用点才失败。
  if (unknown.length > 0) {
    return {
      ...base,
      error: `声明了宿主不认识的能力：${unknown.join("、")}`,
      unknownPermissions: unknown,
    };
  }

  try {
    const source = await readPluginEntry(packageRecord.id);
    const pluginModule = await importPluginModule(packageRecord.id, source);
    const host = createPluginHost({
      hostVersion: APP_META.version,
      permissions: granted,
      pluginId: packageRecord.id,
      pluginVersion: packageRecord.manifest.version,
    });

    await pluginModule.activate(host);
    activePlugins.set(packageRecord.id, { host, module: pluginModule });

    return { ...base, loadedAt: Date.now(), permissions: granted, status: "loaded" };
  } catch (error) {
    // 激活中途失败可能已经产生副作用（例如起了定时器），因此显式清理已注册项，
    // 避免下一次「重新加载」把同一个插件当成已激活而跳过激活。
    activePlugins.delete(packageRecord.id);

    return { ...base, error: describeError(error), permissions: granted };
  }
}

/**
 * 把插件源码包装成可执行模块。
 *
 * 源码以 Blob URL 形式交给原生动态 `import`，模块被当作普通 ESM 处理，
 * 不需要 `eval` 或 `new Function`，因此不受脚本内联相关安全策略限制。
 */
async function importPluginModule(pluginId: string, source: string): Promise<PluginModule> {
  const blob = new Blob([source], { type: "text/javascript" });
  const blobUrl = URL.createObjectURL(blob);

  try {
    // `@vite-ignore` 保留这条运行期动态导入：URL 每次运行才生成，静态分析阶段
    // 既无法把它替换成模块路径，也不应该尝试解析它。
    const loaded = (await import(/* @vite-ignore */ blobUrl)) as Partial<PluginModule>;

    if (typeof loaded.activate !== "function") {
      throw new Error(`插件 ${pluginId} 的入口文件必须导出 activate(host) 函数`);
    }

    return loaded as PluginModule;
  } finally {
    // 模块在 import 阶段已完成实例化，源码进入 ESM 模块表，Blob URL 可以立即回收，
    // 不需要等到插件卸载——否则每个插件都会长期占用一份源码内存。
    URL.revokeObjectURL(blobUrl);
  }
}

/**
 * 确保通知事件只订阅一次。
 */
async function ensureNotificationListener(): Promise<void> {
  if (notificationUnlisten) {
    return;
  }

  notificationUnlisten = await listenPluginNotification((event) => {
    appendPluginNotification(event.payload);
  });
}

/**
 * 合并式更新快照，保持快照对象不可变，便于组件做浅层比对。
 */
function updateSnapshot(patch: Partial<PluginRuntimeSnapshot>): void {
  snapshot.value = { ...snapshot.value, ...patch };
}

/**
 * 把任意异常收敛成面板可展示的字符串。
 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : "插件加载失败，原因未知";
}
