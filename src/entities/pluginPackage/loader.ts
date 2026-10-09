import { readonly, shallowRef } from "vue";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { APP_META } from "@/shared/config/appMeta";
import {
  emitPluginUiRender,
  listenPluginHostReady,
  listenPluginNotification,
  listenPluginUiEvent,
} from "@/shared/ipc/pluginPackage";
import { listPlugins, readPluginEntry } from "./api";
import { resolvePluginPermissions } from "./permissions";
import {
  PLUGIN_NOTIFICATION_LIMIT,
  type PluginNotificationPayload,
  type PluginPackageRecord,
  type PluginRuntimeRecord,
  type PluginRuntimeSnapshot,
  type PluginUiNode,
} from "./types";
import { startPluginWorker, type PluginWorkerHandle } from "./worker/host";

/**
 * 已激活插件表，key 为插件 id。
 *
 * 表里保存的是 Worker 句柄：卸载时要通过它请求插件收尾，再终止 Worker。
 * 插件本体已经不在主线程里，这里也拿不到它的模块对象——这正是隔离生效的标志。
 */
interface ActivePlugin {
  worker: PluginWorkerHandle;
}

const activePlugins = new Map<string, ActivePlugin>();

/**
 * 各插件最近一次下发的界面描述。
 *
 * 放在模块级而不是插件记录里：界面树只在需要渲染时被读取，与运行时列表的
 * 更新节奏无关，混进快照会让每次界面刷新增量重建整个记录数组。
 */
const uiTrees = shallowRef<Record<string, PluginUiNode>>({});

/**
 * 只读界面树视图，插件宿主窗口据此渲染。
 */
export const pluginUiTrees = readonly(uiTrees);

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
 * 插件宿主窗口就绪事件的订阅句柄。
 */
let hostReadyUnlisten: UnlistenFn | null = null;

/**
 * 插件界面交互事件的订阅句柄。
 */
let uiEventUnlisten: UnlistenFn | null = null;

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
 * 先把它从已激活表里摘掉再请求收尾：插件在收尾过程中再次触发加载流程时，
 * 不会被误判成「已经激活」而直接跳过。
 */
export async function unloadPlugin(pluginId: string): Promise<void> {
  const active = activePlugins.get(pluginId);
  if (!active) {
    return;
  }

  activePlugins.delete(pluginId);

  try {
    await active.worker.deactivate();
  } catch (error) {
    // 卸载失败不应阻塞其它插件，也不应该让宿主崩在一个第三方收尾逻辑上。
    console.error(`[plugin] ${pluginId} 卸载失败`, error);
  }

  clearPluginUiTree(pluginId);

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
 * 释放宿主级订阅与全部 Worker，供应用级收尾与开发热更新使用。
 *
 * 热更新会重新执行本模块，如果不终止 Worker，旧实例会连同它们的定时器一起变成孤儿；
 * 旧模块持有的监听器也会继续追加到已被替换的快照上。
 */
export function disposePluginRuntime(): void {
  for (const active of activePlugins.values()) {
    active.worker.dispose();
  }

  activePlugins.clear();
  uiTrees.value = {};

  notificationUnlisten?.();
  notificationUnlisten = null;
  hostReadyUnlisten?.();
  hostReadyUnlisten = null;
  uiEventUnlisten?.();
  uiEventUnlisten = null;
  initializationPromise = null;
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
 * 把插件界面上的交互回传给对应插件。
 *
 * 插件不存在（尚未激活或已被卸载）时静默丢弃：点击发生在独立窗口里，
 * 而窗口生命周期可能晚于插件本身，此时抛错只会把问题抛给用户。
 */
export function sendPluginUiEvent(pluginId: string, action: string, payload?: unknown): void {
  activePlugins.get(pluginId)?.worker.sendUiEvent(action, payload);
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
    await ensurePluginHostReadyListener();
    await ensurePluginUiEventForwarder();

    const scan = await listPlugins();
    const records: PluginRuntimeRecord[] = [];

    // 逐包串行激活而不是并发：插件激活通常包含文件读写，串行能让日志顺序与列表顺序一致，
    // 也更符合「插件数量是十几个量级」的实际规模。激活现在跑在独立 Worker 里，
    // 单个插件的死循环不会再卡住宿主主线程。
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
    const worker = await startPluginWorker({
      hostVersion: APP_META.version,
      onUiRender: (tree) => setPluginUiTree(packageRecord.id, tree),
      permissions: granted,
      pluginId: packageRecord.id,
      pluginVersion: packageRecord.manifest.version,
      source,
    });

    activePlugins.set(packageRecord.id, { worker });

    return { ...base, loadedAt: Date.now(), permissions: granted, status: "loaded" };
  } catch (error) {
    // 激活中途失败可能已经产生副作用，因此显式清理已注册项，
    // 避免下一次「重新加载」把同一个插件当成已激活而跳过激活。
    activePlugins.delete(packageRecord.id);
    clearPluginUiTree(packageRecord.id);

    return { ...base, error: describeError(error), permissions: granted };
  }
}

/**
 * 记录一次界面下发。
 */
function setPluginUiTree(pluginId: string, tree: PluginUiNode): void {
  uiTrees.value = { ...uiTrees.value, [pluginId]: tree };

  // 插件宿主窗口是独立 WebView，读不到本窗口的内存状态，界面树只能靠事件同步过去。
  void emitPluginUiRender({ pluginId, tree });
}

/**
 * 清掉某个插件的界面树。
 */
function clearPluginUiTree(pluginId: string): void {
  if (!(pluginId in uiTrees.value)) {
    return;
  }

  const next = { ...uiTrees.value };
  delete next[pluginId];
  uiTrees.value = next;
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
 * 确保插件宿主窗口的就绪握手只订阅一次。
 *
 * 窗口挂载完成后广播「就绪」，这里回发它当前需要的界面树。用握手而不是在创建窗口后
 * 直接补发，是为了避开「事件早于监听器注册」的时序问题——新建窗口的监听器注册完成时间
 * 无法从外部准确推断。
 */
async function ensurePluginHostReadyListener(): Promise<void> {
  if (hostReadyUnlisten) {
    return;
  }

  hostReadyUnlisten = await listenPluginHostReady((event) => {
    const pluginId = event.payload;
    const tree = uiTrees.value[pluginId];

    if (tree) {
      void emitPluginUiRender({ pluginId, tree });
    }
  });
}

/**
 * 确保界面交互转发只订阅一次。
 *
 * 交互事件来自插件宿主窗口（另一个 WebView），这里把它转交给对应插件的 Worker。
 * 刻意不做权限校验：只有声明了 `ui:panel` 的插件才可能产生界面交互，而且交互本身
 * 不触达任何宿主能力——它只是把数据交给插件自己。
 */
async function ensurePluginUiEventForwarder(): Promise<void> {
  if (uiEventUnlisten) {
    return;
  }

  uiEventUnlisten = await listenPluginUiEvent((event) => {
    const { action, payload, pluginId } = event.payload;

    sendPluginUiEvent(pluginId, action, payload);
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
