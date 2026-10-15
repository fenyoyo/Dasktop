<script setup lang="ts">
import { ref } from "vue";
import { AppWindow, Check, ExternalLink, Puzzle, RefreshCw, ShieldAlert, ShieldCheck, X } from "@lucide/vue";
import {
  PLUGIN_PERMISSION_DEFINITIONS,
  PLUGIN_WINDOW_SIZE_LIMITS,
  PLUGIN_WINDOW_SIZE_SOURCE_LABELS,
  type PluginPermission,
  type PluginRuntimeRecord,
  type PluginRuntimeSnapshot,
} from "@/entities/pluginPackage";
import type { AppSettings } from "@/entities/appSettings/types";
import SettingGroup from "../components/SettingGroup.vue";
import SettingRow from "../components/SettingRow.vue";
import SettingSection from "../components/SettingSection.vue";

/**
 * 插件面板展示插件安装位置、可用状态、权限声明、窗口尺寸与最近通知。
 *
 * 面板自身不触发扫描：扫描编排由设置页根组件负责，
 * 这样用户不进入本页签时插件列表也已经是就绪的。
 *
 * 窗口尺寸在这里分成两块：全局默认值与每个插件各自的覆盖值。
 * 面板只负责把「当前哪个值在生效、它来自哪里」说清楚：每个插件的生效尺寸由宿主在
 * 扫描时算好并随记录下发，面板不再自己推导优先级与边界。
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
  pluginWindowSizeChange: [key: PluginWindowSizeSettingKey, value: number];
  pluginWindowSizeReset: [pluginId: string];
  pluginWindowSizeSave: [pluginId: string, width: number, height: number];
}>();

/**
 * 全局默认窗口尺寸涉及的两个设置键；窄化到这两项而不是放开全部数值设置键，
 * 面板改动就不会意外写坏别的用户偏好。
 */
type PluginWindowSizeSettingKey = "pluginWindowHeight" | "pluginWindowWidth";

/**
 * 面板内操作按钮与 Box 面板共用同一视觉语言，避免设置页出现两个按钮体系。
 */
const ACTION_BUTTON_CLASS =
  "inline-flex h-9 items-center gap-2 rounded-[9px] border border-[#dfe2e8] bg-[#ffffff] px-3 text-[13px] font-medium text-[#555b66] transition-colors hover:bg-[#f6f7fa] hover:text-[#17181c] disabled:cursor-not-allowed disabled:opacity-45 dark:border-[#292c34] dark:bg-[#181a20] dark:text-[#a7abb5] dark:hover:bg-[#202229] dark:hover:text-[#f4f4f5]";

/**
 * 插件卡片内的小尺寸操作按钮：视觉上从属于卡片，与旁边的权限标签同一量级，
 * 不跟面板顶部的主操作按钮争夺注意力。
 */
const CARD_ACTION_CLASS =
  "inline-flex items-center gap-1 rounded-full border border-[#dfe2e8] px-2 py-[3px] text-[11px] font-medium text-[#555b66] transition-colors hover:bg-[#f6f7fa] hover:text-[#17181c] disabled:cursor-not-allowed disabled:opacity-45 dark:border-[#33363f] dark:text-[#a7abb5] dark:hover:bg-[#202229] dark:hover:text-[#f4f4f5]";

/**
 * 数字输入框的统一样式。
 *
 * 面板给整个设置窗加了 `user-select: none`（防止拖拽窗口时误选文案），输入框要靠
 * `select-text` 自己争取回来，否则用户没法双击选中一个三位数重填。
 */
const NUMBER_INPUT_CLASS =
  "h-8 w-[76px] select-text rounded-[8px] border border-[#dfe2e8] bg-[#ffffff] px-2 text-center text-[13px] text-[#202229] outline-none transition-colors focus:border-[#9aa0ac] dark:border-[#33363f] dark:bg-[#202229] dark:text-[#f4f4f5]";

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
  PLUGIN_PERMISSION_DEFINITIONS.map((definition) => [definition.permission, definition.summary]),
);

/**
 * 状态到展示文案的映射。
 *
 * 只有「可用 / 不可用」两态：页面模式下插件不需要被激活，扫描通过就随时能打开。
 * 用「就绪」而不用「已加载」，是为了不让人以为宿主已经把插件代码跑起来了——
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
 * 该插件是否单独记住过窗口尺寸；只有记住过的才需要显示「重置」。
 */
function hasRememberedWindowSize(record: PluginRuntimeRecord): boolean {
  return record.windowSize.source === "custom";
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
  const width = Number.isFinite(draftWidth.value) ? draftWidth.value : record.windowSize.width;
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
function changeGlobalWindowSize(key: PluginWindowSizeSettingKey, rawValue: string): void {
  const numeric = Number(rawValue);

  if (!Number.isFinite(numeric)) {
    return;
  }

  emit("pluginWindowSizeChange", key, numeric);
}
</script>

<template>
  <SettingSection
    description="插件包目录、可用状态与能力声明"
    :panel-width="panelWidth"
    title="插件"
  >
    <SettingGroup>
      <SettingRow title="插件目录" :divided="true">
        <template #description>
          <p class="mt-1 truncate text-[12px] leading-5 text-[#707684] dark:text-[#9ca0aa]">
            {{ runtime.rootPath || "读取中" }}
          </p>
        </template>

        <div class="flex items-center gap-2">
          <button
            :class="ACTION_BUTTON_CLASS"
            :disabled="!runtime.rootPath"
            type="button"
            @click="emit('openRoot')"
          >
            <ExternalLink :size="15" />
            打开
          </button>
          <button
            :class="ACTION_BUTTON_CLASS"
            :disabled="runtime.loading"
            type="button"
            @click="emit('reload')"
          >
            <RefreshCw :size="15" />
            {{ runtime.loading ? "扫描中" : "重新加载" }}
          </button>
        </div>
      </SettingRow>

      <SettingRow
        description="没有单独调整过的插件窗口按这个尺寸打开；拖动过某个插件窗口后，那个插件会记住自己的尺寸"
        :divided="true"
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
            @change="changeGlobalWindowSize('pluginWindowWidth', ($event.target as HTMLInputElement).value)"
          />
          <span aria-hidden="true" class="text-[12px] text-[#9aa0ac]">&times;</span>
          <input
            aria-label="默认窗口高度"
            :class="NUMBER_INPUT_CLASS"
            :max="PLUGIN_WINDOW_SIZE_LIMITS.height.max"
            :min="PLUGIN_WINDOW_SIZE_LIMITS.height.min"
            :step="PLUGIN_WINDOW_SIZE_LIMITS.height.step"
            type="number"
            :value="settings.pluginWindowHeight"
            @change="changeGlobalWindowSize('pluginWindowHeight', ($event.target as HTMLInputElement).value)"
          />
          <span class="text-[12px] text-[#9aa0ac]">px</span>
        </div>
      </SettingRow>

      <SettingRow
        :description="`每个子目录是一个插件包，需包含 plugin.json 与入口页面；共 ${runtime.records.length} 个`"
        :divided="runtime.records.length > 0"
        title="已安装插件"
      />

      <SettingRow
        v-for="(record, index) in runtime.records"
        :key="record.id"
        :divided="index < runtime.records.length - 1"
        grid-class="grid-cols-[minmax(0,1fr)_auto]"
        :title="record.name"
      >
        <template #description>
          <p class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] leading-5 text-[#707684] dark:text-[#9ca0aa]">
            <span>{{ record.id }}</span>
            <span aria-hidden="true">·</span>
            <span>v{{ record.version || "未知" }}</span>
            <template v-if="record.entry">
              <span aria-hidden="true">·</span>
              <span>{{ record.entry }}</span>
            </template>
          </p>

          <p
            v-if="record.error"
            class="mt-2 text-[12px] leading-5 text-[#b52a2a] dark:text-[#ff9c9c]"
          >
            {{ record.error }}
          </p>

          <div class="mt-2 flex flex-wrap items-center gap-2">
            <template v-if="editingPluginId === record.id">
              <input
                v-model.number="draftWidth"
                aria-label="插件窗口宽度"
                :class="NUMBER_INPUT_CLASS"
                :max="PLUGIN_WINDOW_SIZE_LIMITS.width.max"
                :min="PLUGIN_WINDOW_SIZE_LIMITS.width.min"
                :step="PLUGIN_WINDOW_SIZE_LIMITS.width.step"
                type="number"
              />
              <span aria-hidden="true" class="text-[12px] text-[#9aa0ac]">&times;</span>
              <input
                v-model.number="draftHeight"
                aria-label="插件窗口高度"
                :class="NUMBER_INPUT_CLASS"
                :max="PLUGIN_WINDOW_SIZE_LIMITS.height.max"
                :min="PLUGIN_WINDOW_SIZE_LIMITS.height.min"
                :step="PLUGIN_WINDOW_SIZE_LIMITS.height.step"
                type="number"
              />
              <button
                :class="CARD_ACTION_CLASS"
                title="保存这个插件的窗口尺寸"
                type="button"
                @click="commitWindowSize(record)"
              >
                <Check :size="12" />
                保存
              </button>
              <button
                :class="CARD_ACTION_CLASS"
                title="放弃修改"
                type="button"
                @click="cancelWindowSizeEditing()"
              >
                <X :size="12" />
                取消
              </button>
            </template>

            <template v-else>
              <span class="text-[12px] leading-5 text-[#707684] dark:text-[#9ca0ac]">
                窗口 {{ record.windowSize.width }} &times; {{ record.windowSize.height }} px ·
                {{ PLUGIN_WINDOW_SIZE_SOURCE_LABELS[record.windowSize.source] }}
              </span>
              <button
                :class="CARD_ACTION_CLASS"
                :disabled="record.status !== 'ready'"
                title="为这个插件单独设置窗口尺寸"
                type="button"
                @click="startEditingWindowSize(record)"
              >
                调整尺寸
              </button>
              <button
                v-if="hasRememberedWindowSize(record)"
                :class="CARD_ACTION_CLASS"
                title="忘掉这个插件记住的尺寸，回到清单声明或全局默认值"
                type="button"
                @click="emit('pluginWindowSizeReset', record.id)"
              >
                重置
              </button>
            </template>
          </div>
        </template>

        <div class="flex max-w-[300px] flex-wrap items-center justify-end gap-1.5 py-3">
          <span
            v-for="permission in record.permissions"
            :key="permission"
            class="inline-flex items-center gap-1 rounded-full border border-[#dfe2e8] px-2 py-[3px] text-[11px] font-medium text-[#555b66] dark:border-[#33363f] dark:text-[#a7abb5]"
            :title="describePermission(permission)"
          >
            <ShieldCheck :size="12" />
            {{ permission }}
          </span>

          <span
            v-for="permission in record.unknownPermissions"
            :key="permission"
            class="inline-flex items-center gap-1 rounded-full border border-[#f0c7c7] px-2 py-[3px] text-[11px] font-medium text-[#b52a2a] dark:border-[#5b2a2d] dark:text-[#ff9c9c]"
            title="宿主不认识该权限，插件已被标记为不可用"
          >
            <ShieldAlert :size="12" />
            {{ permission }}
          </span>

          <span
            class="rounded-full px-2 py-[3px] text-[11px] font-medium"
            :class="STATUS_CLASSES[record.status]"
          >
            {{ STATUS_LABELS[record.status] }}
          </span>

          <button
            :class="CARD_ACTION_CLASS"
            :disabled="record.status !== 'ready'"
            :title="
              record.status === 'ready' ? '打开插件页面' : (record.error ?? '插件不可用')
            "
            type="button"
            @click="emit('openPage', record.id)"
          >
            <AppWindow :size="12" />
            打开
          </button>
        </div>
      </SettingRow>

      <div v-if="runtime.records.length === 0" class="px-5 py-10 text-center">
        <Puzzle class="mx-auto text-[#b8bcc6] dark:text-[#6a7180]" :size="22" />
        <p class="mt-2 text-[13px] font-semibold text-[#202229] dark:text-[#f4f4f5]">
          {{ runtime.loading ? "正在扫描插件目录" : "还没有插件" }}
        </p>
        <p class="mt-1 text-[12px] text-[#707684] dark:text-[#9ca0aa]">
          打开插件目录，把插件包文件夹放进去后点击重新加载
        </p>
      </div>
    </SettingGroup>

    <div
      v-if="runtime.error"
      class="mt-4 rounded-[8px] border border-[#f0c7c7] bg-[#fff6f6] px-4 py-3 text-[13px] text-[#9f1d1d] dark:border-[#5b2a2d] dark:bg-[#281619] dark:text-[#ffb4b4]"
    >
      插件扫描失败：{{ runtime.error }}
    </div>

    <SettingGroup class="mt-4">
      <SettingRow
        :description="
          runtime.notifications.length > 0
            ? `插件通过宿主能力发送，最多保留最近 ${runtime.notifications.length} 条`
            : '插件通过宿主能力发送的通知会显示在这里，并同时写入插件日志'"
        :divided="runtime.notifications.length > 0"
        title="最近通知"
      />

      <div
        v-for="(notification, index) in runtime.notifications"
        :key="`${notification.createdAt}-${index}`"
        class="px-5 py-3"
        :class="index < runtime.notifications.length - 1 ? 'border-b border-[#e7e9ee] dark:border-[#292c34]' : ''"
      >
        <div class="flex items-center gap-2">
          <strong class="truncate text-[13px] font-semibold text-[#202229] dark:text-[#f4f4f5]">
            {{ notification.title }}
          </strong>
          <span class="ml-auto shrink-0 text-[11px] text-[#8b909b] dark:text-[#8b909b]">
            {{ formatNotificationTime(notification.createdAt) }}
          </span>
        </div>
        <p class="mt-1 text-[12px] leading-5 text-[#707684] dark:text-[#9ca0aa]">
          {{ notification.message }}
        </p>
        <p class="mt-1 text-[11px] text-[#9aa0ac] dark:text-[#7c828d]">
          来自 {{ notification.pluginId }}
        </p>
      </div>
    </SettingGroup>
  </SettingSection>
</template>
