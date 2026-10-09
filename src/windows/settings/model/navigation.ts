import { Boxes, FolderKanban, Info, Layers, Palette, Puzzle, SlidersHorizontal } from "@lucide/vue";
import type { Component } from "vue";

/**
 * 设置页导航键值统一收口，避免侧栏、标题和内容区域各自维护字符串。
 */
export type SettingsSection =
  | "boxes"
  | "workspace"
  | "file"
  | "window"
  | "appearance"
  | "plugins"
  | "about";

/**
 * 设置页左侧导航项，icon 使用组件类型以便保持 Lucide 图标风格一致。
 */
export interface SettingsNavItem {
  key: SettingsSection;
  label: string;
  icon: Component;
}

/**
 * 设置页内容宽度由父窗口统一定义，再下发给各面板以保持视觉密度一致。
 */
export const SETTINGS_PANEL_WIDTH = {
  default: "max-w-[780px]",
} as const;

/**
 * 设置页只展示当前真实可用的主菜单，收纳能力合并到 Box 页避免侧栏过细。
 * 工作区紧随 Box 之后，符合“先摆放桌面、再按场景组织”的使用顺序；
 * 插件排在关于之前，与「先用功能、再看信息」的阅读顺序一致。
 */
export const SETTINGS_SECTIONS: readonly SettingsNavItem[] = [
  { key: "boxes", label: "Box", icon: Boxes },
  { key: "workspace", label: "工作区", icon: Layers },
  { key: "file", label: "规则显示", icon: FolderKanban },
  { key: "window", label: "窗口启动", icon: SlidersHorizontal },
  { key: "appearance", label: "外观", icon: Palette },
  { key: "plugins", label: "插件", icon: Puzzle },
  { key: "about", label: "关于", icon: Info },
];

/**
 * 标题从导航配置派生，避免新增菜单时遗漏窗口标题。
 */
export function resolveSettingsSectionTitle(section: SettingsSection): string {
  return SETTINGS_SECTIONS.find((item) => item.key === section)?.label ?? "设置";
}
