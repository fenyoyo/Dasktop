import { computed, type ComputedRef } from "vue";
import {
  initializePluginRuntime,
  openPluginWindow,
  pluginRuntime,
  reloadPluginRuntime,
  resetPluginWindowSize as forgetPluginWindowSize,
  savePluginWindowSize as rememberPluginWindowSize,
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
  /** 忘掉某个插件记住的窗口尺寸，让它回到清单声明或全局默认值。 */
  resetPluginWindowSize: (pluginId: string) => Promise<void>;
  /** 只读运行时快照，面板直接消费。 */
  runtime: ComputedRef<PluginRuntimeSnapshot>;
  /** 记住某个插件的窗口尺寸。 */
  savePluginWindowSize: (pluginId: string, width: number, height: number) => Promise<void>;
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

  async function rememberWindowSize(
    pluginId: string,
    width: number,
    height: number,
  ): Promise<void> {
    try {
      // 原样写库：夹取由宿主在取用时统一完成，面板随后展示的也是宿主收敛后的值。
      await rememberPluginWindowSize(pluginId, { width, height });
    } catch (error) {
      console.error("[plugin] 保存插件窗口尺寸失败", error);
    }
  }

  async function forgetWindowSize(pluginId: string): Promise<void> {
    try {
      await forgetPluginWindowSize(pluginId);
    } catch (error) {
      console.error("[plugin] 重置插件窗口尺寸失败", error);
    }
  }

  return {
    initializePlugins,
    openPluginPage,
    openPluginsRoot,
    reloadPlugins,
    resetPluginWindowSize: forgetWindowSize,
    runtime,
    savePluginWindowSize: rememberWindowSize,
  };
}
