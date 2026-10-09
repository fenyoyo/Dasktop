import { computed, type ComputedRef } from "vue";
import {
  initializePluginRuntime,
  pluginRuntime,
  reloadPluginRuntime,
  type PluginRuntimeSnapshot,
} from "@/entities/pluginPackage";
import { openPluginRoot } from "@/entities/pluginPackage/api";

/**
 * 设置页使用的插件运行时上下文。
 */
export interface SettingsPluginsContext {
  /**
   * 首次扫描并激活插件。由设置页根组件在挂载时调用。
   *
   * 必须放在根组件而不是插件面板里：面板由 `v-else-if` 条件渲染，
   * 用户不切到插件页签时组件根本不挂载，`onMounted` 永远不会执行。
   */
  initializePlugins: () => Promise<void>;
  /** 用系统资源管理器打开插件根目录。 */
  openPluginsRoot: () => Promise<void>;
  /** 卸载全部插件后重新扫描激活。 */
  reloadPlugins: () => Promise<void>;
  /** 只读运行时快照，面板直接消费。 */
  runtime: ComputedRef<PluginRuntimeSnapshot>;
}

/**
 * 把插件加载器的运行时状态接到设置页。
 *
 * 这里只做编排和错误隔离：加载失败不抛出，而是留在快照的 `error` 字段里展示，
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

  return { initializePlugins, openPluginsRoot, reloadPlugins, runtime };
}
