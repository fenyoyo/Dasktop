import { computed, ref, type ComputedRef } from "vue";
import {
  listForegroundPinHotkey,
  setForegroundPinHotkey,
} from "@/entities/appSettings/api";
import type { ForegroundPinHotkeyRegistration } from "@/entities/appSettings/types";

/**
 * 设置页使用的应用级全局快捷键上下文。
 */
export interface SettingsHotkeyContext {
  /** 置顶快捷键的当前状态；首次读取完成前为 `null`，面板据此显示空态。 */
  foregroundPinHotkey: ComputedRef<ForegroundPinHotkeyRegistration | null>;
  /** 保存失败的原因（例如快捷键不合法），成功或重新读取后清空。 */
  errorMessage: ComputedRef<string>;
  /** 读取配置，由设置页根组件在挂载时调用。 */
  loadForegroundPinHotkey: () => Promise<void>;
  /** 保存配置（组合键 + 是否启用），成功后用返回值刷新状态。 */
  saveForegroundPinHotkey: (accelerator: string, enabled: boolean) => Promise<void>;
}

/**
 * 把「置顶当前前台窗口」全局快捷键接到设置页。
 *
 * 与 `useSettingsPlugins` 的分工一致：只做编排和错误隔离。读取失败不抛出，热键配置读不到
 * 顶多让这一行显示「未配置」，不该让整个设置窗挂掉。
 *
 * 状态刻意存在本组合式而不是全局 Store：目前只有窗口面板消费这一条配置，为它单开一个
 * 跨窗口共享的 Store 属于过度设计，设置页自身就是一个独立窗口。
 */
export function useSettingsHotkey(): SettingsHotkeyContext {
  const registration = ref<ForegroundPinHotkeyRegistration | null>(null);
  const errorMessageValue = ref("");

  async function loadForegroundPinHotkey(): Promise<void> {
    try {
      registration.value = await listForegroundPinHotkey();
      errorMessageValue.value = "";
    } catch (error) {
      // 命令返回的是纯文案（Rust 的 `Err(String)`），用 String 兜底而不是要求 Error 实例。
      errorMessageValue.value = String(error);
      console.error("[hotkey] 读取置顶快捷键配置失败", error);
    }
  }

  async function saveForegroundPinHotkey(
    accelerator: string,
    enabled: boolean,
  ): Promise<void> {
    try {
      registration.value = await setForegroundPinHotkey(accelerator, enabled);
      errorMessageValue.value = "";
    } catch (error) {
      // 保存失败时保留原有配置：非法快捷键在 Rust 侧就被拒绝，数据库里仍是上一次的有效值。
      errorMessageValue.value = String(error);
      console.error("[hotkey] 保存置顶快捷键失败", error);
    }
  }

  return {
    errorMessage: computed(() => errorMessageValue.value),
    foregroundPinHotkey: computed(() => registration.value),
    loadForegroundPinHotkey,
    saveForegroundPinHotkey,
  };
}
