import type { DesktopNameDisplayMode } from "@/entities/desktopItem/types";
// 插件窗口的默认宽高与允许范围属于插件领域的约定，这里引用它而不是再抄一份字面量：
// 设置页滑块的可选范围与宿主建窗时的取值边界必须是同一个数，抄第二遍迟早会漂移。
import {
  PLUGIN_WINDOW_DEFAULT_SIZE,
  PLUGIN_WINDOW_SIZE_LIMITS,
} from "@/entities/pluginPackage/types";
import type {
  AppSettings,
  BoxConflictPolicy,
  BoxDeletePolicy,
  BoxDropAction,
  ThemeMode,
} from "./types";

/**
 * 数值型设置键由 AppSettings 自动推导，新增数值设置时会被类型系统要求补齐范围
 */
export type AppSettingNumberKey = {
  [Key in keyof AppSettings]: AppSettings[Key] extends number ? Key : never;
}[keyof AppSettings];

/**
 * 布尔型设置键由 AppSettings 自动推导，设置页开关保存时复用统一逻辑
 */
export type AppSettingBooleanKey = {
  [Key in keyof AppSettings]: AppSettings[Key] extends boolean ? Key : never;
}[keyof AppSettings];

/**
 * 应用设置表和键名统一收口，避免 Store、数据库和设置面板各自硬编码字符串
 */
export const APP_SETTINGS_STORAGE = {
  databaseUrl: "sqlite:dasktop.db",
  tables: {
    appSettings: "app_settings",
    boxItemOrders: "box_item_orders",
    boxVirtualItems: "box_virtual_items",
    boxes: "boxes",
    // 与 Rust `domain/app/settings.rs` 的 tables::PLUGIN_WINDOW_SIZES 同名：
    // 两侧分别负责读写同一张表（宿主在窗口关闭时写回，设置页负责展示与重置）。
    pluginWindowSizes: "plugin_window_sizes",
    shellIconVisibilityRecords: "shell_icon_visibility_records",
    workspaces: "workspaces",
  },
} as const;

/**
 * 设置键名使用对象常量承载，调用保存逻辑时始终复用同一份字段定义
 */
export const APP_SETTING_KEYS = {
  boxBackgroundOpacity: "boxBackgroundOpacity",
  boxCollapseAnimationMs: "boxCollapseAnimationMs",
  boxCollapseDelayMs: "boxCollapseDelayMs",
  boxConflictPolicy: "boxConflictPolicy",
  boxCornerRadius: "boxCornerRadius",
  boxDeletePolicy: "boxDeletePolicy",
  boxDragOutAction: "boxDragOutAction",
  boxDropAction: "boxDropAction",
  boxFilenameWidth: "boxFilenameWidth",
  boxIdleOpacityHideAnimationMs: "boxIdleOpacityHideAnimationMs",
  boxIdleOpacityShowAnimationMs: "boxIdleOpacityShowAnimationMs",
  boxIconGapX: "boxIconGapX",
  boxIconGapY: "boxIconGapY",
  boxIconSize: "boxIconSize",
  boxLabelTextSize: "boxLabelTextSize",
  boxResizeGridEnabled: "boxResizeGridEnabled",
  boxTheme: "boxTheme",
  collectionRootPath: "collectionRootPath",
  doubleClickOpenItems: "doubleClickOpenItems",
  nameDisplayMode: "nameDisplayMode",
  pluginWindowHeight: "pluginWindowHeight",
  pluginWindowWidth: "pluginWindowWidth",
  settingsTheme: "settingsTheme",
  autoHideNativeShellIcons: "autoHideNativeShellIcons",
  showItemLabels: "showItemLabels",
  showShortcutArrow: "showShortcutArrow",
  snapThreshold: "snapThreshold",
  snapToEdges: "snapToEdges",
} as const satisfies Record<keyof AppSettings, keyof AppSettings>;

/**
 * 默认设置只包含文件夹型 Box 真实生效的字段，旧版参数不再兼容
 */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  settingsTheme: "system",
  boxTheme: "system",
  collectionRootPath: "",
  boxDeletePolicy: "moveContentsToDesktop",
  boxDropAction: "move",
  boxDragOutAction: "move",
  boxConflictPolicy: "rename",
  showItemLabels: true,
  showShortcutArrow: true,
  autoHideNativeShellIcons: true,
  doubleClickOpenItems: true,
  nameDisplayMode: "hideShortcutExtension",
  snapToEdges: true,
  boxResizeGridEnabled: true,
  snapThreshold: 20,
  boxBackgroundOpacity: 70,
  boxCollapseAnimationMs: 420,
  boxCollapseDelayMs: 420,
  boxIdleOpacityHideAnimationMs: 420,
  boxIdleOpacityShowAnimationMs: 420,
  boxIconSize: 48,
  boxLabelTextSize: 12,
  boxIconGapX: 6,
  boxIconGapY: 4,
  boxFilenameWidth: 82,
  boxCornerRadius: 8,
  pluginWindowWidth: PLUGIN_WINDOW_DEFAULT_SIZE.width,
  pluginWindowHeight: PLUGIN_WINDOW_DEFAULT_SIZE.height,
};

/**
 * 数值设置的输入范围和持久化校验共用同一份配置，防止 UI 能写入数据库不接受的值
 */
export const APP_SETTING_NUMBER_LIMITS = {
  boxBackgroundOpacity: { min: 0, max: 100, step: 1, unit: "%" },
  boxCollapseAnimationMs: { min: 120, max: 600, step: 10, unit: "ms" },
  boxCollapseDelayMs: { min: 0, max: 2000, step: 20, unit: "ms" },
  boxCornerRadius: { min: 0, max: 24, step: 1, unit: "px" },
  boxFilenameWidth: { min: 56, max: 180, step: 1, unit: "px" },
  boxIdleOpacityHideAnimationMs: { min: 0, max: 1200, step: 20, unit: "ms" },
  boxIdleOpacityShowAnimationMs: { min: 0, max: 1200, step: 20, unit: "ms" },
  boxIconGapX: { min: 0, max: 32, step: 1, unit: "px" },
  boxIconGapY: { min: 0, max: 32, step: 1, unit: "px" },
  boxIconSize: { min: 28, max: 96, step: 1, unit: "px" },
  boxLabelTextSize: { min: 9, max: 16, step: 0.5, unit: "px" },
  snapThreshold: { min: 8, max: 64, step: 1, unit: "px" },
  pluginWindowHeight: PLUGIN_WINDOW_SIZE_LIMITS.height,
  pluginWindowWidth: PLUGIN_WINDOW_SIZE_LIMITS.width,
} as const satisfies Record<
  AppSettingNumberKey,
  {
    max: number;
    min: number;
    step: number;
    unit: string;
  }
>;

/**
 * 支持的设置键由默认设置派生，新增设置时只需要补齐默认值和校验逻辑
 */
export const SUPPORTED_APP_SETTING_KEYS = Object.values(APP_SETTING_KEYS);

/**
 * 明暗主题枚举和 UI 选项共用同一份值，避免设置读取接受 UI 不存在的状态
 */
export const THEME_MODES = ["light", "system", "dark"] as const satisfies readonly ThemeMode[];

/**
 * Box 文件名显示模式集中定义，设置页和数据库校验使用同一组可选值
 */
export const DESKTOP_NAME_DISPLAY_MODES = [
  "full",
  "hideShortcutExtension",
  "hideAllExtensions",
] as const satisfies readonly DesktopNameDisplayMode[];

/**
 * Box 删除策略集中定义，设置页和数据库校验使用同一组可选值
 */
export const BOX_DELETE_POLICIES = [
  "moveContentsToDesktop",
  "keepFolder",
  "recycleFolder",
] as const satisfies readonly BoxDeletePolicy[];

/**
 * 拖入策略集中定义，设置页、数据库校验和后端命令共用同一组可选值
 */
export const BOX_DROP_ACTIONS = ["copy", "move", "map"] as const satisfies readonly BoxDropAction[];

/**
 * 同名文件处理策略集中定义，默认重命名用于彻底绕开 Windows 冲突弹窗层级问题
 */
export const BOX_CONFLICT_POLICIES = [
  "rename",
  "skip",
  "replace",
] as const satisfies readonly BoxConflictPolicy[];

/**
 * 数值设置统一做范围夹取和小数精度归一，避免无效历史数据撑破布局
 */
export function sanitizeNumberAppSetting<Key extends AppSettingNumberKey>(
  key: Key,
  value: unknown,
): AppSettings[Key] {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return DEFAULT_APP_SETTINGS[key] as AppSettings[Key];
  }

  const limit = APP_SETTING_NUMBER_LIMITS[key];
  const clampedValue = Math.min(Math.max(value, limit.min), limit.max);
  const decimalPlaces = getDecimalPlaces(limit.step);

  return Number(clampedValue.toFixed(decimalPlaces)) as AppSettings[Key];
}

/**
 * 步长决定持久化精度，0.5 这类设置需要保留一位小数
 */
function getDecimalPlaces(step: number): number {
  const [, decimal = ""] = String(step).split(".");

  return decimal.length;
}
