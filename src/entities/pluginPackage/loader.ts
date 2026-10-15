import { readonly, shallowRef } from "vue";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  deletePluginWindowSize,
  savePluginWindowSize as persistPluginWindowSize,
} from "@/shared/storage/database";
import { listenPluginNotification } from "@/shared/ipc/pluginPackage";
import { listPluginHotkeys, listPlugins, setPluginHotkey } from "./api";
import { resolvePluginPermissions } from "./permissions";
import {
  PLUGIN_NOTIFICATION_LIMIT,
  type PluginNotificationPayload,
  type PluginPackageRecord,
  type PluginRuntimeRecord,
  type PluginRuntimeSnapshot,
  type PluginWindowSize,
} from "./types";

/**
 * 插件运行时状态。
 *
 * 页面模式下的加载器只做一件事：把磁盘上的插件包扫成一份可展示的记录。它不执行任何
 * 插件代码，也不持有插件对象——插件的页面由 WebView 在独立窗口里加载，生命周期跟宿主
 * 这边没有交集。因此这里没有「激活 / 卸载」这对动作，也没有需要回收的资源。
 */

/**
 * 运行时快照。用 `shallowRef` 而不是 `reactive`：快照整体替换，
 * 深层响应式只会让插件记录数组被无谓地代理一遍。
 */
const snapshot = shallowRef<PluginRuntimeSnapshot>({
  error: null,
  hotkeys: [],
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
 * 宿主启动编排和用户手动「重新加载」可能同时触发，共享 Promise 保证并发调用只扫一次；
 * 否则两次扫描的结果会互相覆盖，面板上出现难以复现的闪烁。
 */
let initializationPromise: Promise<void> | null = null;

/**
 * 通知事件订阅句柄，用于避免重复订阅与释放时漏退订。
 */
let notificationUnlisten: UnlistenFn | null = null;

/**
 * 首次调用时扫描插件目录；重复调用复用同一次扫描。
 */
export async function initializePluginRuntime(): Promise<void> {
  if (!initializationPromise) {
    initializationPromise = scanPluginPackages();
  }

  return initializationPromise;
}

/**
 * 重新扫描插件目录，供宿主面板的「重新加载」使用。
 *
 * 不需要先卸载什么：插件页面跑在各自的窗口里，重扫只影响宿主这边的一份记录。
 */
export async function reloadPluginRuntime(): Promise<void> {
  initializationPromise = scanPluginPackages();

  return initializationPromise;
}

/**
 * 记住某个插件的窗口尺寸。
 *
 * 宿主在插件窗口关闭时也会写同一张表，因此这里的写入与「用户自己拖出来的尺寸」是同一份
 * 数据：设置页改完立刻生效，下次开窗就用它（正在开着的窗口不会被改动，那是用户此刻正在
 * 调整的尺寸）。
 *
 * 写完重新扫描一次而不是本地改快照：面板上显示的尺寸是宿主算出来的（夹取过、带来源），
 * 前端本地拼一个值就等于又实现了一遍尺寸规则。
 */
export async function savePluginWindowSize(
  pluginId: string,
  size: PluginWindowSize,
): Promise<void> {
  await persistPluginWindowSize(pluginId, size);

  await reloadPluginRuntime();
}

/**
 * 忘掉某个插件记住的窗口尺寸，让它回到清单声明或全局默认值。
 */
export async function resetPluginWindowSize(pluginId: string): Promise<void> {
  await deletePluginWindowSize(pluginId);

  await reloadPluginRuntime();
}

/**
 * 释放宿主级订阅，供应用级收尾与开发热更新使用。
 *
 * 热更新会重新执行本模块，旧模块持有的监听器会继续追加到已被替换的快照上。
 */
export function disposePluginRuntime(): void {
  notificationUnlisten?.();
  notificationUnlisten = null;
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
 * 扫描插件目录并生成运行时记录。
 *
 * 本函数不向外抛错：扫描失败会被写进快照的 `error` 字段，调用方（启动编排）不需要为
 * 「插件扫描失败」单独写错误处理，也不会因此中断宿主启动。
 */
async function scanPluginPackages(): Promise<void> {
  updateSnapshot({ error: null, loading: true });

  try {
    await ensureNotificationListener();

    // 窗口尺寸与热键注册状态各自独立计算：尺寸由宿主在扫描时算好随包下发，
    // 热键状态则由 `list_plugin_hotkeys` 聚合清单、用户覆盖与冲突后返回。两条链互不依赖，
    // 并行取避免一次设置页刷新被拖成两次往返。
    const [scan, hotkeys] = await Promise.all([listPlugins(), listPluginHotkeys()]);

    updateSnapshot({
      error: null,
      hotkeys,
      loading: false,
      records: scan.packages.map(describePackage),
      rootPath: scan.rootPath,
    });
  } catch (error) {
    updateSnapshot({ error: describeError(error), loading: false });
  }
}

/**
 * 把扫描结果转换成一个运行时记录。
 *
 * 所有失败路径都返回记录而不是抛错，保证一个坏插件不影响同批次其它插件。
 */
function describePackage(packageRecord: PluginPackageRecord): PluginRuntimeRecord {
  const base: PluginRuntimeRecord = {
    directoryPath: packageRecord.directoryPath,
    entry: packageRecord.manifest?.entry ?? "",
    error: null,
    id: packageRecord.id,
    name: packageRecord.manifest?.name ?? packageRecord.id,
    permissions: [],
    status: "failed",
    unknownPermissions: [],
    version: packageRecord.manifest?.version ?? "",
    windowSize: packageRecord.windowSize,
  };

  if (!packageRecord.manifest) {
    return { ...base, error: packageRecord.error ?? "插件清单不可用" };
  }

  const { granted, unknown } = resolvePluginPermissions(packageRecord.manifest.permissions);

  // 声明了宿主不认识的能力，说明该插件是按更高版本宿主编写的。直接标记为不可用而不是
  // 忽略未知权限，否则用户会以为一切正常，直到某个功能静默失效才回来排查。
  if (unknown.length > 0) {
    return {
      ...base,
      error: `声明了宿主不认识的能力：${unknown.join("、")}`,
      unknownPermissions: unknown,
    };
  }

  return { ...base, permissions: granted, status: "ready" };
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

  return typeof error === "string" ? error : "插件扫描失败，原因未知";
}

/**
 * 保存某个插件的启动热键配置（生效快捷键 + 是否启用），保存后重新拉取注册状态刷新面板。
 *
 * 配置写库由宿主命令完成，前端不直连表；重拉一次是为了让冲突 / 非法状态立刻反映出来，
 * 而不是停留在用户刚点保存那一刻的旧快照上。
 */
export async function savePluginHotkey(
  pluginId: string,
  accelerator: string,
  enabled: boolean,
): Promise<void> {
  await setPluginHotkey(pluginId, accelerator, enabled);
  await reloadPluginHotkeys();
}

/**
 * 仅重新拉取热键注册状态，不动插件目录扫描。
 *
 * 改键或切开关后用它刷新，比整页重扫更轻：热键状态聚合不依赖窗口尺寸计算，没必要为了
 * 一个开关把整个插件目录再扫一遍。
 */
export async function reloadPluginHotkeys(): Promise<void> {
  try {
    const hotkeys = await listPluginHotkeys();
    updateSnapshot({ hotkeys });
  } catch (error) {
    console.error("[plugin] 读取插件热键失败", error);
  }
}
