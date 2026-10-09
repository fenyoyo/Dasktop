<script setup lang="ts">
import { ExternalLink, Puzzle, RefreshCw, ShieldAlert, ShieldCheck } from "@lucide/vue";
import {
  PLUGIN_PERMISSION_DEFINITIONS,
  type PluginPermission,
  type PluginRuntimeRecord,
  type PluginRuntimeSnapshot,
} from "@/entities/pluginPackage";
import SettingGroup from "../components/SettingGroup.vue";
import SettingRow from "../components/SettingRow.vue";
import SettingSection from "../components/SettingSection.vue";

/**
 * 插件面板展示插件安装位置、加载结果、权限声明与最近通知。
 *
 * 面板自身不触发任何加载：加载编排由设置页根组件负责，
 * 这样用户不进入本页签时插件依然会被激活。
 */
defineProps<{
  panelWidth: string;
  runtime: PluginRuntimeSnapshot;
}>();

const emit = defineEmits<{
  openRoot: [];
  reload: [];
}>();

/**
 * 面板内操作按钮与 Box 面板共用同一视觉语言，避免设置页出现两个按钮体系。
 */
const ACTION_BUTTON_CLASS =
  "inline-flex h-9 items-center gap-2 rounded-[9px] border border-[#dfe2e8] bg-[#ffffff] px-3 text-[13px] font-medium text-[#555b66] transition-colors hover:bg-[#f6f7fa] hover:text-[#17181c] disabled:cursor-not-allowed disabled:opacity-45 dark:border-[#292c34] dark:bg-[#181a20] dark:text-[#a7abb5] dark:hover:bg-[#202229] dark:hover:text-[#f4f4f5]";

/**
 * 权限标签的说明文案从权限映射表派生，界面与真实能力始终同源。
 */
const PERMISSION_SUMMARIES = new Map<string, string>(
  PLUGIN_PERMISSION_DEFINITIONS.map((definition) => [definition.permission, definition.summary]),
);

/**
 * 状态到展示文案的映射。
 */
const STATUS_LABELS: Record<PluginRuntimeRecord["status"], string> = {
  failed: "加载失败",
  loaded: "已加载",
  unloaded: "已卸载",
};

/**
 * 状态到标签样式的映射，刻意区分「失败」与「已卸载」，避免用户把正常卸载当成故障。
 */
const STATUS_CLASSES: Record<PluginRuntimeRecord["status"], string> = {
  failed:
    "bg-[#fff1f1] text-[#b52a2a] dark:bg-[#3a2226] dark:text-[#ff9c9c]",
  loaded:
    "bg-[#eef8f0] text-[#1f7a44] dark:bg-[#1d3025] dark:text-[#7ddba5]",
  unloaded:
    "bg-[#f1f2f5] text-[#6a7180] dark:bg-[#242730] dark:text-[#9ca0aa]",
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
</script>

<template>
  <SettingSection
    description="插件包目录、加载状态与能力授权"
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
            {{ runtime.loading ? "加载中" : "重新加载" }}
          </button>
        </div>
      </SettingRow>

      <SettingRow
        :description="`每个子目录是一个插件包，需包含 plugin.json 与入口源码；共 ${runtime.records.length} 个`"
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
            <template v-if="record.loadedAt > 0">
              <span aria-hidden="true">·</span>
              <span>{{ formatNotificationTime(record.loadedAt) }} 激活</span>
            </template>
          </p>

          <p
            v-if="record.error"
            class="mt-2 text-[12px] leading-5 text-[#b52a2a] dark:text-[#ff9c9c]"
          >
            {{ record.error }}
          </p>
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
            title="宿主不认识该权限，插件已被拒绝加载"
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
      插件加载失败：{{ runtime.error }}
    </div>

    <SettingGroup class="mt-4">
      <SettingRow
        :description="
          runtime.notifications.length > 0
            ? `插件通过 ui:notify 发送，最多保留最近 ${runtime.notifications.length} 条`
            : '插件调用 ui:notify 后，通知会显示在这里并同时写入插件日志'"
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
