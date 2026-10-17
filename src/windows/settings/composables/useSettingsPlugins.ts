import { computed, type ComputedRef } from "vue";
import {
  initializePluginRuntime,
  openPluginWindow,
  pluginRuntime,
  reloadPluginHotkeys,
  reloadPluginRuntime,
  savePluginHotkey,
  syncPluginPackagesFromRepo,
  type PluginRuntimeSnapshot,
} from "@/entities/pluginPackage";
import { openPluginRoot } from "@/entities/pluginPackage/api";

/**
 * 设置页使用的插件运行时上下文。
 */
export interface SettingsPluginsContext {
  /**
   * 首次扫描插件目录。由设置页根组件在挂载时调用。
   *
   * 必须放在根组件而不是插件面板里：面板由 `v-else-if` 条件渲染，
   * 用户不切到插件页签时组件根本不挂载，`onMounted` 永远不会执行。
   */
  initializePlugins: () => Promise<void>;
  /** 用系统资源管理器打开插件根目录。 */
  openPluginsRoot: () => Promise<void>;
  /** 打开插件的界面窗口，展示它的入口页面；窗口已存在时调到前台。 */
  openPluginPage: (pluginId: string) => Promise<void>;
  /** 重新扫描插件目录。 */
  reloadPlugins: () => Promise<void>;
  /**
   * 把仓库里的插件包同步到插件目录（开发调试用），同步后自动重扫。
   *
   * 直接接加载器的实现而不是再包一层 try/catch：加载器已经保证不抛错，
   * 失败会落在快照的 `error` 字段里由面板展示，这里再兜一层只会把错误吞掉。
   */
  syncPlugins: () => Promise<void>;
  /** 只读运行时快照，面板直接消费。 */
  runtime: ComputedRef<PluginRuntimeSnapshot>;
  /** 保存某个插件的启动热键配置（生效快捷键 + 是否启用）。 */
  savePluginHotkey: (
    pluginId: string,
    accelerator: string,
    enabled: boolean,
  ) => Promise<void>;
  /** 重新拉取热键注册状态，不动插件目录扫描。 */
  reloadPluginHotkeys: () => Promise<void>;
}

/**
 * 把插件加载器的运行时状态接到设置页。
 *
 * 这里只做编排和错误隔离：扫描失败不抛出，而是留在快照的 `error` 字段里展示，
 * 插件问题不应该让设置窗整体挂掉。
 */
export function useSettingsPlugins(): SettingsPluginsContext {
  const runtime = computed<PluginRuntimeSnapshot>(() => pluginRuntime.value);

  async function initializePlugins(): Promise<void> {
    await initializePluginRuntime();
  }

  async function reloadPlugins(): Promise<void> {
    await reloadPluginRuntime();
  }

  async function openPluginsRoot(): Promise<void> {
    try {
      await openPluginRoot();
    } catch (error) {
      console.error("[plugin] 打开插件目录失败", error);
    }
  }

  async function openPluginPage(pluginId: string): Promise<void> {
    try {
      await openPluginWindow(pluginId);
    } catch (error) {
      // 窗口创建失败不该让设置页崩掉：插件界面是可选功能，失败只记日志。
      console.error("[plugin] 打开插件界面失败", error);
    }
  }

  async function rememberPluginHotkey(
    pluginId: string,
    accelerator: string,
    enabled: boolean,
  ): Promise<void> {
    try {
      await savePluginHotkey(pluginId, accelerator, enabled);
    } catch (error) {
      console.error("[plugin] 保存插件热键失败", error);
    }
  }

  async function refreshPluginHotkeys(): Promise<void> {
    await reloadPluginHotkeys();
  }

  return {
    initializePlugins,
    openPluginPage,
    openPluginsRoot,
    reloadPlugins,
    runtime,
    savePluginHotkey: rememberPluginHotkey,
    syncPlugins: syncPluginPackagesFromRepo,
    reloadPluginHotkeys: refreshPluginHotkeys,
  };
}
