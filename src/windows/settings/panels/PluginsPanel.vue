<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref } from "vue";
import {
  ArrowUpRight,
  Check,
  Download,
  ExternalLink,
  Pencil,
  Puzzle,
  RefreshCw,
  RotateCcw,
  Ruler,
  ShieldAlert,
  ShieldCheck,
  X,
} from "@lucide/vue";
import {
  PLUGIN_PERMISSION_DEFINITIONS,
  PLUGIN_WINDOW_DEFAULT_SIZE,
  PLUGIN_WINDOW_SIZE_LIMITS,
  PLUGIN_WINDOW_SIZE_SOURCE_LABELS,
  type PluginHotkeyRegistration,
  type PluginHotkeyStatus,
  type PluginPermission,
  type PluginRuntimeRecord,
  type PluginRuntimeSnapshot,
} from "@/entities/pluginPackage";
import type { AppSettings } from "@/entities/appSettings/types";
import SettingGroup from "../components/SettingGroup.vue";
import SettingRow from "../components/SettingRow.vue";
import SettingSection from "../components/SettingSection.vue";

/**
 * 插件面板按「目录 → 窗口尺寸 → 插件列表 → 通知」四段组织。
 *
 * 面板自身不触发扫描：扫描编排由设置页根组件负责，
 * 这样用户不进入本页签时插件列表也已经是就绪的。
 *
 * 每个插件的生效尺寸由宿主在扫描时算好并随记录下发，面板只负责呈现「当前是哪个值、
 * 它来自哪里」，不再自行推导优先级与边界。
 */
const props = defineProps<{
  panelWidth: string;
  runtime: PluginRuntimeSnapshot;
  settings: AppSettings;
}>();

const emit = defineEmits<{
  openPage: [pluginId: string];
  openRoot: [];
  reload: [];
  syncPlugins: [];
  pluginWindowSizeChange: [key: PluginWindowSizeSettingKey, value: number];
  pluginWindowSizeReset: [pluginId: string];
  pluginWindowSizeSave: [pluginId: string, width: number, height: number];
  pluginHotkeySave: [pluginId: string, accelerator: string, enabled: boolean];
  pluginHotkeyReload: [];
}>();

/**
 * 全局默认窗口尺寸涉及的两个设置键；窄化到这两项而不是放开全部数值设置键，
 * 面板改动就不会意外写坏别的用户偏好。
 */
type PluginWindowSizeSettingKey = "pluginWindowHeight" | "pluginWindowWidth";

/**
 * 面板顶部的操作按钮，与 Box 面板共用同一视觉语言，避免设置页出现两个按钮体系。
 */
const ACTION_BUTTON_CLASS =
  "inline-flex h-9 items-center gap-2 rounded-[9px] border border-[#dfe2e8] bg-[#ffffff] px-3 text-[13px] font-medium text-[#555b66] transition-colors hover:bg-[#f6f7fa] hover:text-[#17181c] disabled:cursor-not-allowed disabled:opacity-45 dark:border-[#292c34] dark:bg-[#181a20] dark:text-[#a7abb5] dark:hover:bg-[#202229] dark:hover:text-[#f4f4f5]";

/**
 * 插件卡片内的次要操作按钮：高度与主按钮对齐，视觉权重低于「打开」，
 * 避免每个插件行出现两个同等强度的入口。
 */
const SECONDARY_BUTTON_CLASS =
  "inline-flex h-8 items-center gap-1.5 rounded-[7px] border border-[#dfe2e8] px-2.5 text-[12px] font-medium text-[#555b66] transition-colors hover:bg-[#f6f7fa] hover:text-[#17181c] disabled:cursor-not-allowed disabled:opacity-45 dark:border-[#33363f] dark:text-[#a7abb5] dark:hover:bg-[#242730] dark:hover:text-[#f4f4f5]";

/**
 * 打开插件是每行唯一的主操作，沿用设置页强调色但去掉投影：
 * 强调色的投影是留给「新增 Box」这类全页唯一入口的，这里每行都出现一次，
 * 带投影会让整列按钮连成一条抢眼的色带。
 */
const PRIMARY_BUTTON_CLASS =
  "inline-flex h-8 items-center gap-1.5 rounded-[7px] bg-[#ff5c5c] px-3 text-[12px] font-semibold text-white transition-colors hover:bg-[#ee4d4d] disabled:cursor-not-allowed disabled:opacity-45";

/**
 * 编辑态里的图标按钮保持 32px 稳定尺寸，切换编辑态时不会挤动相邻输入框。
 */
const ICON_BUTTON_CLASS =
  "grid size-8 place-items-center rounded-[7px] text-[#68707d] transition-colors hover:bg-[#eef0f4] hover:text-[#17181c] dark:text-[#a7abb5] dark:hover:bg-[#242730] dark:hover:text-[#f4f4f5]";

/**
 * 数字输入框的统一样式。
 *
 * 面板给整个设置窗加了 `user-select: none`（防止拖拽窗口时误选文案），输入框要靠
 * `select-text` 自己争取回来，否则用户没法双击选中一个三位数重填。
 */
const NUMBER_INPUT_CLASS =
  "h-8 w-[76px] select-text rounded-[8px] border border-[#dfe2e8] bg-[#ffffff] px-2 text-center text-[13px] text-[#202229] outline-none transition-colors focus:border-[#9aa0ac] dark:border-[#33363f] dark:bg-[#202229] dark:text-[#f4f4f5]";

/**
 * 权限标签：与状态徽标同高，放在插件行底部单独一行，不与标题争夺视线。
 */
const PERMISSION_CHIP_CLASS =
  "inline-flex items-center gap-1 rounded-full border border-[#dfe2e8] px-2 py-[3px] text-[11px] font-medium text-[#555b66] dark:border-[#33363f] dark:text-[#a7abb5]";

const UNKNOWN_PERMISSION_CHIP_CLASS =
  "inline-flex items-center gap-1 rounded-full border border-[#f0c7c7] px-2 py-[3px] text-[11px] font-medium text-[#b52a2a] dark:border-[#5b2a2d] dark:text-[#ff9c9c]";

/**
 * 正在编辑窗口尺寸的插件 id；同时只允许一个插件处于编辑态，
 * 表单状态因此不需要按插件分组。
 */
const editingPluginId = ref<string | null>(null);

/** 编辑中的宽高草稿，进入编辑态时用当前生效值填充。 */
const draftWidth = ref<number>(0);
const draftHeight = ref<number>(0);

/**
 * 权限标签的说明文案从权限映射表派生，界面与真实能力始终同源。
 */
const PERMISSION_SUMMARIES = new Map<string, string>(
  PLUGIN_PERMISSION_DEFINITIONS.map((definition) => [
    definition.permission,
    definition.summary,
  ]),
);

/**
 * 状态到展示文案的映射。
 *
 * 只有「可用 / 不可用」两态：页面模式下插件不需要被激活，扫描通过就随时能打开。
 * 用「可用」而不用「已加载」，是为了不让人以为宿主已经把插件代码跑起来了——
 * 它只是登记了这个包，真正加载页面的是插件窗口。
 */
const STATUS_LABELS: Record<PluginRuntimeRecord["status"], string> = {
  failed: "不可用",
  ready: "可用",
};

const STATUS_CLASSES: Record<PluginRuntimeRecord["status"], string> = {
  failed: "bg-[#fff1f1] text-[#b52a2a] dark:bg-[#3a2226] dark:text-[#ff9c9c]",
  ready: "bg-[#eef8f0] text-[#1f7a44] dark:bg-[#1d3025] dark:text-[#7ddba5]",
};

/**
 * 加载失败的图标地址集合。
 *
 * 图标经插件协议按需拉取，个别插件的图片可能在扫描之后才损坏或被删。以 URL 为键而不是
 * 插件 id：作者修好文件并重新加载后，宿主会下发新地址（路径或缓存语义变化），旧的失败
 * 记录不应继续遮蔽新图标。用不可变 Set 整体替换，保持与运行时快照相同的浅层响应式风格。
 */
const brokenIconUrls = ref<ReadonlySet<string>>(new Set());

/**
 * 单个图标加载失败时只隐藏这一张、回退占位拼图，不阻断该行的其它信息展示。
 */
function handleIconLoadError(iconUrl: string): void {
  if (!iconUrl || brokenIconUrls.value.has(iconUrl)) {
    return;
  }

  brokenIconUrls.value = new Set(brokenIconUrls.value).add(iconUrl);
}

/**
 * 通知时间只精确到秒：面板用于判断事件先后，不需要毫秒。
 */
function formatNotificationTime(createdAt: number): string {
  if (!createdAt) {
    return "--:--:--";
  }

  return new Date(createdAt).toLocaleTimeString("zh-CN", { hour12: false });
}

/**
 * 读取权限说明，未登记的权限回退为空字符串而不是抛错。
 */
function describePermission(permission: PluginPermission | string): string {
  return PERMISSION_SUMMARIES.get(permission) ?? "";
}

/**
 * 该插件是否单独记住过窗口尺寸；只有记住过的才需要「恢复默认」。
 */
function hasRememberedWindowSize(record: PluginRuntimeRecord): boolean {
  return record.windowSize.source === "custom";
}

/**
 * 全局默认尺寸是否仍是宿内置默认值，用于决定「恢复默认」按钮是否可点。
 */
function isGlobalSizeDefault(): boolean {
  return (
    props.settings.pluginWindowWidth === PLUGIN_WINDOW_DEFAULT_SIZE.width &&
    props.settings.pluginWindowHeight === PLUGIN_WINDOW_DEFAULT_SIZE.height
  );
}

/**
 * 进入某个插件的尺寸编辑态。
 */
function startEditingWindowSize(record: PluginRuntimeRecord): void {
  editingPluginId.value = record.id;
  draftWidth.value = record.windowSize.width;
  draftHeight.value = record.windowSize.height;
}

/**
 * 提交尺寸修改。
 *
 * 输入框清空会得到 NaN，此时回落到当前生效值而不是把窗口压到下限——
 * 「没填」应当按没改处理，用户只是还没决定。
 */
function commitWindowSize(record: PluginRuntimeRecord): void {
  const width = Number.isFinite(draftWidth.value)
    ? draftWidth.value
    : record.windowSize.width;
  const height = Number.isFinite(draftHeight.value)
    ? draftHeight.value
    : record.windowSize.height;

  emit("pluginWindowSizeSave", record.id, width, height);
  editingPluginId.value = null;
}

/**
 * 放弃本次修改。
 */
function cancelWindowSizeEditing(): void {
  editingPluginId.value = null;
}

/**
 * 提交全局默认尺寸的一处修改。
 *
 * 按 `@change` 而不是每次按键提交：数字输入框在输入过程中会出现空值与中间态，
 * 逐字保存会把没写完的值写进数据库。
 */
function changeGlobalWindowSize(
  key: PluginWindowSizeSettingKey,
  rawValue: string,
): void {
  const numeric = Number(rawValue);

  if (!Number.isFinite(numeric)) {
    return;
  }

  emit("pluginWindowSizeChange", key, numeric);
}

/**
 * 把全局默认尺寸恢复成宿内置值。
 *
 * 一次性发两个键而不是加一条「重置全部」命令：这两项是独立存储的设置，
 * 走既有通道才能保证与其它设置的写入路径完全一致。
 */
function resetGlobalWindowSize(): void {
  emit(
    "pluginWindowSizeChange",
    "pluginWindowWidth",
    PLUGIN_WINDOW_DEFAULT_SIZE.width,
  );
  emit(
    "pluginWindowSizeChange",
    "pluginWindowHeight",
    PLUGIN_WINDOW_DEFAULT_SIZE.height,
  );
}

/* ---- 快捷键管理 ---- */

/**
 * 启用开关的两态样式：复用状态徽标的红 / 绿配色，让用户一眼区分「在用 / 已关」。
 */
const ENABLED_TOGGLE_CLASS =
  "inline-flex h-8 shrink-0 items-center rounded-[7px] border px-2.5 text-[12px] font-medium transition-colors";
const ENABLED_ON_CLASS =
  "border-[#bfe3cd] bg-[#eef8f0] text-[#1f7a44] dark:border-[#1d3025] dark:bg-[#1d3025] dark:text-[#7ddba5]";
const ENABLED_OFF_CLASS =
  "border-[#f0c7c7] bg-[#fff1f1] text-[#b52a2a] dark:border-[#5b2a2d] dark:bg-[#3a2226] dark:text-[#ff9c9c]";

/**
 * 改键输入框的样式：比数字输入框宽一点，但同样抢回 `select-text` 以免没法重填。
 */
const TEXT_INPUT_CLASS =
  "h-8 w-[120px] select-text rounded-[8px] border border-[#dfe2e8] bg-[#ffffff] px-2 text-center text-[13px] text-[#202229] outline-none transition-colors focus:border-[#9aa0ac] dark:border-[#33363f] dark:bg-[#202229] dark:text-[#f4f4f5]";

/**
 * 状态到说明文案的兜底：列表项里 `message` 优先，`message` 缺失时回这里。
 *
 * `message` 由宿主按具体冲突对象生成（例如「与插件 A 的热键冲突」），比这里的通用文案更准；
 * 兜底只兜底渲染不塌，不是主路径。
 */
const HOTKEY_STATUS_LABELS: Record<PluginHotkeyStatus, string> = {
  ok: "",
  systemReserved: "系统保留组合，无法注册",
  invalid: "快捷键格式不合法",
  conflict: "与其它插件热键冲突",
  disabled: "已禁用",
};

/** 当前正在改键的热键（用 `插件id/热键id` 当唯一键），`null` 表示没有行处于编辑态。 */
const editingHotkeyKey = ref<string | null>(null);
const draftAccelerator = ref<string>("");

/** 插件 id 到展示名的映射，热键列表只带 pluginId，要靠它补出可读的标题。 */
const pluginNames = computed(() => {
  const nameMap = new Map<string, string>();
  for (const record of props.runtime.records) {
    nameMap.set(record.id, record.name);
  }
  return nameMap;
});

/**
 * 编辑态键直接取插件 id：新模型下每插件最多一条启动热键，pluginId 本身即唯一。
 * 直接用对象当 key 会让 Vue 的 `v-if` 比较失去稳定引用。
 */
function hotkeyKey(hotkey: PluginHotkeyRegistration): string {
  return hotkey.pluginId;
}

/**
 * 当前正在编辑的整条热键记录：window 级捕获监听需要它来提交 / 取消，
 * 因为捕获不依赖输入框焦点，按键可能发生在页面任何位置。
 */
let editingHotkey: PluginHotkeyRegistration | null = null;

/** 进入编辑态时挂到 window 上的捕获监听，离开编辑态移除；`onUnmounted` 兜底避免泄漏。 */
let removeCaptureListener: (() => void) | null = null;

function stopCapturing(): void {
  removeCaptureListener?.();
  removeCaptureListener = null;
}

function startEditingHotkey(hotkey: PluginHotkeyRegistration): void {
  // 从一行切到另一行改键时，先把前一个编辑态的 window 监听撤掉，避免按键同时写两份草稿。
  stopCapturing();
  editingHotkeyKey.value = hotkeyKey(hotkey);
  editingHotkey = hotkey;
  draftAccelerator.value = hotkey.accelerator;

  // 热键是「按下即捕获」，不能依赖输入框获得焦点：它位于 v-for 内、又是只读框，
  // 某些平台收不到 keydown，聚焦还会因为 v-for 的 ref 被收集成数组而落空，落空就存进空串、
  // 状态永远停在「未配置快捷键」。直接挂 window 级捕获（捕获阶段），按键无论焦点在哪都被抓到。
  const handler = (event: KeyboardEvent): void => captureHotkey(event);
  window.addEventListener("keydown", handler, true);
  removeCaptureListener = (): void =>
    window.removeEventListener("keydown", handler, true);

  // 仍把焦点给输入框作为回退：极少数平台 window 级捕获拿不到物理键位时，
  // 聚焦后的输入框 keydown 还能兜底抓一次。用 id 定位，避开 v-for 的 ref 数组陷阱。
  nextTick(() => document.getElementById("plugin-hotkey-input")?.focus());
}

/**
 * 捕获热键时忽略的「裸修饰键」：它们单独按下不组成完整组合键，等主键落下再一起记录。
 */
const HOTKEY_MODIFIER_KEYS = new Set([
  "Control",
  "Alt",
  "Shift",
  "Meta",
  "Win",
  "OS",
]);

/**
 * 从按键事件里取出主键名。
 *
 * 优先用 `event.code`（物理键位，如 `KeyT` / `Digit1` / `F5`），而不是 `event.key`：
 * 按住 `Alt` 时 `event.key` 经常被输入法、死键或 AltGr 吞掉 / 改写成奇怪的值，导致
 * 只捕获到修饰键、主键丢失，结果存进空串、状态停在「未配置快捷键」。物理键位不受这些影响。
 */
function keyFromEvent(event: KeyboardEvent): string | null {
  const code = event.code;
  if (/^Key[A-Z]$/.test(code)) {
    return code.slice(3); // KeyT -> T
  }
  if (/^Digit[0-9]$/.test(code)) {
    return code.slice(5); // Digit1 -> 1
  }
  if (/^Numpad[0-9]$/.test(code)) {
    return code.slice(6); // Numpad1 -> 1
  }
  if (/^F([1-9]|1[0-2])$/.test(code)) {
    return code; // F1..F12 原样保留
  }

  const named: Record<string, string> = {
    Space: "Space",
    ArrowUp: "ArrowUp",
    ArrowDown: "ArrowDown",
    ArrowLeft: "ArrowLeft",
    ArrowRight: "ArrowRight",
    Backspace: "Backspace",
    Delete: "Delete",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
  };
  if (named[code]) {
    return named[code];
  }

  // 其它单字符键（符号等）退回 event.key，统一大写保证稳定。
  if (event.key && event.key.length === 1) {
    return event.key.toUpperCase();
  }
  return null;
}

/**
 * 编辑态开启时挂在 window 上捕获用户按下的组合键，构造形如 `Alt+T` / `Ctrl+Alt+T` 的快捷键字符串。
 *
 * 必须是「按下即捕获」而不是普通文本输入：快捷键是组合键，用户在普通文本框里敲不出
 * `Alt+T`（按住 Alt 时浏览器不会往输入框写字），结果就是保存了一个空串、状态始终停在
 * 「未配置快捷键」。这里在 keydown 里直接读修饰键与主键、拼成字符串，并 `preventDefault`
 * 挡掉浏览器/系统对组合键的默认响应（如 Alt 拉起菜单），否则捕获到的不会是用户想绑的键。
 *
 * 回车提交、Esc 取消：捕获在 window 层完成，因此不依赖输入框获得焦点。
 */
function captureHotkey(event: KeyboardEvent): void {
  // 回车提交、Esc 取消；Tab 不当成主键，直接放过去避免把焦点切换吞掉。
  if (event.key === "Enter") {
    if (editingHotkey) {
      commitHotkey(editingHotkey);
    }
    return;
  }
  if (event.key === "Escape" || event.key === "Tab") {
    cancelHotkeyEditing();
    return;
  }

  // 单独按下修饰键只是组合键的前奏，此刻还不完整，不能记录。
  if (HOTKEY_MODIFIER_KEYS.has(event.key)) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  const tokens: string[] = [];
  if (event.ctrlKey) tokens.push("Ctrl");
  if (event.altKey) tokens.push("Alt");
  if (event.shiftKey) tokens.push("Shift");
  if (event.metaKey) tokens.push("Meta");

  const key = keyFromEvent(event);
  if (key) {
    tokens.push(key);
  }

  draftAccelerator.value = tokens.join("+");
}

function cancelHotkeyEditing(): void {
  editingHotkeyKey.value = null;
  editingHotkey = null;
  stopCapturing();
}

/**
 * 提交改键：把当前草稿交给宿主命令，由它做权威校验与持久化。
 *
 * 草稿可能不合法（少修饰键、含 Win），交给 Rust 侧 `validate_accelerator` 判定，
 * 前端不重复实现规则——重复实现的最终归宿是「设置页说能存、按下却没反应」这种分叉。
 */
function commitHotkey(hotkey: PluginHotkeyRegistration): void {
  const value = draftAccelerator.value.trim();
  emit("pluginHotkeySave", hotkey.pluginId, value, hotkey.enabled);
  editingHotkeyKey.value = null;
  editingHotkey = null;
  stopCapturing();
}

/**
 * 切换启用状态：开关即时保存，不需要进入编辑态。
 *
 * 禁用一条热键不需要合法快捷键（关掉它时没必要先填一个能注册的键），所以直接沿用
 * 当前声明的 accelerator 作为覆盖值。
 */
function toggleHotkeyEnabled(hotkey: PluginHotkeyRegistration): void {
  emit(
    "pluginHotkeySave",
    hotkey.pluginId,
    hotkey.accelerator,
    !hotkey.enabled,
  );
}

/**
 * 清除已配置的启动热键：把 accelerator 置空，让插件回到「未配置快捷键」。
 *
 * 只清快捷键本身、不动启用开关：禁用与清除是两件事（禁用是「有键但先不用」，
 * 清除是「不配键」），这里只表达后者。
 */
function clearHotkey(hotkey: PluginHotkeyRegistration): void {
  emit("pluginHotkeySave", hotkey.pluginId, "", hotkey.enabled);
}

// 组件卸载时撤掉可能残留的捕获监听，避免泄漏到其它面板。
onUnmounted(stopCapturing);
</script>

<template>
  <SettingSection
    description="插件包目录、窗口尺寸与能力声明"
    :panel-width="panelWidth"
    title="插件"
  >
    <SettingGroup>
      <SettingRow title="插件目录" :divided="true">
        <template #description>
          <p
            class="mt-1 truncate text-[12px] leading-5 text-[#707684] dark:text-[#9ca0aa]"
          >
            {{ runtime.rootPath || "读取中" }}
          </p>
        </template>

        <div class="flex items-center gap-2">
          <button
            :class="ACTION_BUTTON_CLASS"
            :disabled="!runtime.rootPath || runtime.loading"
            title="把工程目录 plugins/ 下的插件包复制到插件目录，仅供开发调试"
            type="button"
            @click="emit('syncPlugins')"
          >
            <Download :size="15" />
            同步
          </button>
          <button
            :class="ACTION_BUTTON_CLASS"
            :disabled="!runtime.rootPath"
            type="button"
            @click="emit('openRoot')"
          >
            <ExternalLink :size="15" />
            打开
          </button>
        </div>
      </SettingRow>

      <SettingRow
        description="没有单独调整过的插件窗口按这个尺寸打开；拖动某个插件窗口后，它会记住自己的尺寸"
        :divided="false"
        title="默认窗口大小"
      >
        <div class="flex items-center gap-2 py-3">
          <input
            aria-label="默认窗口宽度"
            :class="NUMBER_INPUT_CLASS"
            :max="PLUGIN_WINDOW_SIZE_LIMITS.width.max"
            :min="PLUGIN_WINDOW_SIZE_LIMITS.width.min"
            :step="PLUGIN_WINDOW_SIZE_LIMITS.width.step"
            type="number"
            :value="settings.pluginWindowWidth"
            @change="
              changeGlobalWindowSize(
                'pluginWindowWidth',
                ($event.target as HTMLInputElement).value,
              )
            "
          />
          <span aria-hidden="true" class="text-[12px] text-[#9aa0ac]"
            >&times;</span
          >
          <input
            aria-label="默认窗口高度"
            :class="NUMBER_INPUT_CLASS"
            :max="PLUGIN_WINDOW_SIZE_LIMITS.height.max"
            :min="PLUGIN_WINDOW_SIZE_LIMITS.height.min"
            :step="PLUGIN_WINDOW_SIZE_LIMITS.height.step"
            type="number"
            :value="settings.pluginWindowHeight"
            @change="
              changeGlobalWindowSize(
                'pluginWindowHeight',
                ($event.target as HTMLInputElement).value,
              )
            "
          />
          <span class="text-[12px] text-[#9aa0ac]">px</span>
          <button
            :class="ICON_BUTTON_CLASS"
            :disabled="isGlobalSizeDefault()"
            title="恢复为宿主默认尺寸"
            type="button"
            @click="resetGlobalWindowSize"
          >
            <RotateCcw :size="15" />
          </button>
        </div>
      </SettingRow>
    </SettingGroup>

    <SettingGroup class="mt-4">
      <SettingRow
        :description="`每个子目录是一个插件包，需包含 plugin.json 与入口页面；共 ${runtime.records.length} 个`"
        :divided="runtime.records.length > 0"
        title="已安装插件"
      >
        <button
          :class="ACTION_BUTTON_CLASS"
          :disabled="runtime.loading"
          type="button"
          @click="emit('reload')"
        >
          <RefreshCw :size="15" />
          {{ runtime.loading ? "扫描中" : "重新加载" }}
        </button>
      </SettingRow>

      <SettingRow
        v-for="(record, index) in runtime.records"
        :key="record.id"
        :divided="index < runtime.records.length - 1"
        grid-class="grid-cols-[minmax(0,1fr)_auto]"
        :title="record.name"
      >
        <template #leading>
          <!-- 插件图标：宿主按清单 icon 经插件协议下发地址；未声明或拉取失败时回退拼图占位。 -->
          <div
            class="grid size-9 shrink-0 place-items-center overflow-hidden rounded-[9px] border border-[#dfe2e8] bg-[#f3f4f7] dark:border-[#2f323a] dark:bg-[#202229]"
            :title="record.iconUrl ? undefined : '该插件未声明图标'"
          >
            <img
              v-if="record.iconUrl && !brokenIconUrls.has(record.iconUrl)"
              :src="record.iconUrl"
              alt=""
              class="size-full object-cover"
              @error="handleIconLoadError(record.iconUrl ?? '')"
            />
            <Puzzle v-else :size="17" class="text-[#9aa0ac] dark:text-[#7c828d]" />
          </div>
        </template>
        <template #description>
          <!-- 功能描述紧随名称之后；未声明时整行不渲染，不留空位。 -->
          <p
            v-if="record.description"
            class="mt-1.5 text-[12px] leading-5 text-[#707684] dark:text-[#9ca0aa]"
          >
            {{ record.description }}
          </p>

          <div class="mt-2.5 flex items-center gap-2">
            <span
              class="rounded-full px-2 py-[2px] text-[11px] font-medium"
              :class="STATUS_CLASSES[record.status]"
            >
              {{ STATUS_LABELS[record.status] }}
            </span>
            <span
              class="truncate text-[12px] leading-5 text-[#707684] dark:text-[#9ca0aa]"
            >
              {{ record.id }} · v{{ record.version || "未知" }}
              <template v-if="record.entry"> · {{ record.entry }}</template>
            </span>
          </div>

          <p
            v-if="record.error"
            class="mt-2.5 text-[12px] leading-5 text-[#b52a2a] dark:text-[#ff9c9c]"
          >
            {{ record.error }}
          </p>

          <div class="mt-3 flex flex-wrap items-center gap-2">
            <span
              v-for="permission in record.permissions"
              :key="permission"
              :class="PERMISSION_CHIP_CLASS"
              :title="describePermission(permission)"
            >
              <ShieldCheck :size="12" />
              {{ permission }}
            </span>
            <span
              v-for="permission in record.unknownPermissions"
              :key="permission"
              :class="UNKNOWN_PERMISSION_CHIP_CLASS"
              title="宿主不认识该权限，插件已被标记为不可用"
            >
              <ShieldAlert :size="12" />
              {{ permission }}
            </span>
            <span
              v-if="
                record.permissions.length === 0 &&
                record.unknownPermissions.length === 0
              "
              class="text-[11px] text-[#9aa0ac] dark:text-[#7c828d]"
            >
              未声明能力
            </span>
          </div>

          <!-- 窗口尺寸单独成行：编辑态就地展开，不再把输入框塞进插件描述里 -->
          <div class="mt-3 flex flex-wrap items-center gap-2.5">
            <template v-if="editingPluginId === record.id">
              <Ruler class="shrink-0 text-[#9aa0ac]" :size="14" />
              <input
                v-model.number="draftWidth"
                aria-label="插件窗口宽度"
                :class="NUMBER_INPUT_CLASS"
                :max="PLUGIN_WINDOW_SIZE_LIMITS.width.max"
                :min="PLUGIN_WINDOW_SIZE_LIMITS.width.min"
                :step="PLUGIN_WINDOW_SIZE_LIMITS.width.step"
                type="number"
                @keydown.enter="commitWindowSize(record)"
                @keydown.esc="cancelWindowSizeEditing"
              />
              <span aria-hidden="true" class="text-[12px] text-[#9aa0ac]"
                >&times;</span
              >
              <input
                v-model.number="draftHeight"
                aria-label="插件窗口高度"
                :class="NUMBER_INPUT_CLASS"
                :max="PLUGIN_WINDOW_SIZE_LIMITS.height.max"
                :min="PLUGIN_WINDOW_SIZE_LIMITS.height.min"
                :step="PLUGIN_WINDOW_SIZE_LIMITS.height.step"
                type="number"
                @keydown.enter="commitWindowSize(record)"
                @keydown.esc="cancelWindowSizeEditing"
              />
              <span class="text-[12px] text-[#9aa0ac]">px</span>
              <button
                :class="ICON_BUTTON_CLASS"
                title="保存这个插件的窗口尺寸"
                type="button"
                @click="commitWindowSize(record)"
              >
                <Check :size="15" />
              </button>
              <button
                :class="ICON_BUTTON_CLASS"
                title="放弃修改"
                type="button"
                @click="cancelWindowSizeEditing"
              >
                <X :size="15" />
              </button>
            </template>

            <template v-else>
              <span
                class="inline-flex items-center gap-1.5 text-[12px] leading-5 text-[#707684] dark:text-[#9ca0aa]"
              >
                <Ruler :size="14" />
                {{ record.windowSize.width }} &times;
                {{ record.windowSize.height }} px
                <span class="text-[#9aa0ac] dark:text-[#7c828d]">
                  ·
                  {{
                    PLUGIN_WINDOW_SIZE_SOURCE_LABELS[record.windowSize.source]
                  }}
                </span>
              </span>
              <button
                :class="SECONDARY_BUTTON_CLASS"
                :disabled="record.status !== 'ready'"
                title="为这个插件单独设置窗口尺寸"
                type="button"
                @click="startEditingWindowSize(record)"
              >
                <Ruler :size="13" />
                调整
              </button>
              <button
                v-if="hasRememberedWindowSize(record)"
                :class="SECONDARY_BUTTON_CLASS"
                title="忘掉这个插件记住的尺寸，回到清单声明或全局默认值"
                type="button"
                @click="emit('pluginWindowSizeReset', record.id)"
              >
                <RotateCcw :size="13" />
                恢复默认
              </button>
            </template>
          </div>
        </template>

        <button
          :class="PRIMARY_BUTTON_CLASS"
          :disabled="record.status !== 'ready'"
          :title="
            record.status === 'ready'
              ? '打开插件页面'
              : (record.error ?? '插件不可用')
          "
          type="button"
          @click="emit('openPage', record.id)"
        >
          <ArrowUpRight :size="14" />
          打开
        </button>
      </SettingRow>

      <div v-if="runtime.records.length === 0" class="px-5 py-12 text-center">
        <Puzzle class="mx-auto text-[#b8bcc6] dark:text-[#6a7180]" :size="22" />
        <p
          class="mt-2 text-[13px] font-semibold text-[#202229] dark:text-[#f4f4f5]"
        >
          {{ runtime.loading ? "正在扫描插件目录" : "还没有插件" }}
        </p>
        <p class="mt-1 text-[12px] text-[#707684] dark:text-[#9ca0aa]">
          打开插件目录，把插件包文件夹放进去后点击重新加载
        </p>
      </div>
    </SettingGroup>

    <SettingGroup class="mt-4">
      <SettingRow
        :description="`为每个已安装插件配置一个启动热键；能否真正唤起取决于系统注册结果`"
        :divided="runtime.hotkeys.length > 0"
        title="快捷键"
      >
        <button
          :class="ACTION_BUTTON_CLASS"
          type="button"
          @click="emit('pluginHotkeyReload')"
        >
          <RefreshCw :size="15" />
          刷新
        </button>
      </SettingRow>

      <SettingRow
        v-for="(hotkey, index) in runtime.hotkeys"
        :key="hotkeyKey(hotkey)"
        :divided="index < runtime.hotkeys.length - 1"
        grid-class="grid-cols-[minmax(0,1fr)_auto]"
        :title="pluginNames.get(hotkey.pluginId) ?? hotkey.pluginId"
      >
        <template #description>
          <p
            class="mt-1.5 text-[12px] leading-5 text-[#707684] dark:text-[#9ca0aa]"
          >
            启动热键
          </p>
          <p
            v-if="hotkey.status !== 'ok'"
            class="mt-1.5 text-[12px] leading-5 text-[#b52a2a] dark:text-[#ff9c9c]"
          >
            {{ hotkey.message || HOTKEY_STATUS_LABELS[hotkey.status] }}
          </p>
        </template>

        <div class="flex items-center gap-2">
          <button
            :class="[
              ENABLED_TOGGLE_CLASS,
              hotkey.enabled ? ENABLED_ON_CLASS : ENABLED_OFF_CLASS,
            ]"
            type="button"
            @click="toggleHotkeyEnabled(hotkey)"
          >
            {{ hotkey.enabled ? "已启用" : "已禁用" }}
          </button>

          <template v-if="editingHotkeyKey === hotkeyKey(hotkey)">
            <input
              id="plugin-hotkey-input"
              :value="draftAccelerator"
              aria-label="热键快捷键"
              :class="TEXT_INPUT_CLASS"
              placeholder="按下组合键…"
              readonly
              type="text"
              @keydown="captureHotkey"
            />
            <span
              class="text-[11px] leading-5 text-[#9aa0ac] dark:text-[#7c828d]"
            >
              按下要绑定的组合键
            </span>
            <button
              :class="ICON_BUTTON_CLASS"
              title="保存快捷键"
              type="button"
              @click="commitHotkey(hotkey)"
            >
              <Check :size="15" />
            </button>
            <button
              :class="ICON_BUTTON_CLASS"
              title="放弃修改"
              type="button"
              @click="cancelHotkeyEditing"
            >
              <X :size="15" />
            </button>
          </template>

          <template v-else>
            <span
              class="text-[13px] leading-5 text-[#202229] dark:text-[#f4f4f5]"
            >
              {{ hotkey.accelerator }}
            </span>
            <button
              :class="SECONDARY_BUTTON_CLASS"
              title="修改这条热键"
              type="button"
              @click="startEditingHotkey(hotkey)"
            >
              <Pencil :size="13" />
              改键
            </button>
            <button
              v-if="hotkey.accelerator"
              :class="SECONDARY_BUTTON_CLASS"
              title="清除这条热键"
              type="button"
              @click="clearHotkey(hotkey)"
            >
              <X :size="13" />
              清除
            </button>
          </template>
        </div>
      </SettingRow>

      <div v-if="runtime.hotkeys.length === 0" class="px-5 py-10 text-center">
        <p class="text-[13px] font-semibold text-[#202229] dark:text-[#f4f4f5]">
          还没有已安装的插件
        </p>
        <p class="mt-1 text-[12px] text-[#707684] dark:text-[#9ca0aa]">
          安装插件后，这里会列出每个插件可配置的启动热键
        </p>
      </div>
    </SettingGroup>

    <div
      v-if="runtime.error"
      class="mt-4 rounded-[8px] border border-[#f0c7c7] bg-[#fff6f6] px-4 py-3 text-[13px] text-[#9f1d1d] dark:border-[#5b2a2d] dark:bg-[#281619] dark:text-[#ffb4b4]"
    >
      插件目录操作失败：{{ runtime.error }}
    </div>

    <SettingGroup class="mt-4">
      <SettingRow
        :description="
          runtime.notifications.length > 0
            ? `插件通过宿主能力发送，最多保留最近 ${runtime.notifications.length} 条`
            : '插件通过宿主能力发送的通知会显示在这里，并同时写入插件日志'
        "
        :divided="runtime.notifications.length > 0"
        title="最近通知"
      />

      <div
        v-for="(notification, index) in runtime.notifications"
        :key="`${notification.createdAt}-${index}`"
        class="px-5 py-3.5"
        :class="
          index < runtime.notifications.length - 1
            ? 'border-b border-[#e7e9ee] dark:border-[#292c34]'
            : ''
        "
      >
        <div class="flex items-center gap-2">
          <strong
            class="truncate text-[13px] font-semibold text-[#202229] dark:text-[#f4f4f5]"
          >
            {{ notification.title }}
          </strong>
          <span
            class="ml-auto shrink-0 text-[11px] text-[#8b909b] dark:text-[#8b909b]"
          >
            {{ formatNotificationTime(notification.createdAt) }}
          </span>
        </div>
        <p
          class="mt-1 text-[12px] leading-5 text-[#707684] dark:text-[#9ca0aa]"
        >
          {{ notification.message }}
        </p>
        <p class="mt-1 text-[11px] text-[#9aa0ac] dark:text-[#7c828d]">
          来自 {{ notification.pluginId }}
        </p>
      </div>
    </SettingGroup>
  </SettingSection>
</template>
