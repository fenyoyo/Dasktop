<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useDesktopStore } from "@/entities/desktopBox/store";
import AboutPanel from "./panels/AboutPanel.vue";
import AppearancePanel from "./panels/AppearancePanel.vue";
import BoxesPanel from "./panels/BoxesPanel.vue";
import FilePanel from "./panels/FilePanel.vue";
import PluginsPanel from "./panels/PluginsPanel.vue";
import SettingsHeader from "./components/SettingsHeader.vue";
import SettingsSidebar from "./components/SettingsSidebar.vue";
import WindowPanel from "./panels/WindowPanel.vue";
import WorkspacePanel from "./panels/WorkspacePanel.vue";
import { useSettingsActions } from "./composables/useSettingsActions";
import { useSettingsBoxes } from "./composables/useSettingsBoxes";
import { useSettingsPlugins } from "./composables/useSettingsPlugins";
import { useSettingsStartup } from "./composables/useSettingsStartup";
import { useSettingsWindow } from "./composables/useSettingsWindow";
import { useWorkspaceStartup } from "./composables/useWorkspaceStartup";
import {
  SETTINGS_PANEL_WIDTH,
  SETTINGS_SECTIONS,
  resolveSettingsSectionTitle,
  type SettingsSection,
} from "./model/navigation";

const desktopStore = useDesktopStore();
const activeSection = ref<SettingsSection>("boxes");
const settingsScrollArea = ref<HTMLElement | null>(null);
const activeTitle = computed(() => resolveSettingsSectionTitle(activeSection.value));
const settingsActions = useSettingsActions(desktopStore);
const settingsBoxes = useSettingsBoxes(desktopStore);
const settingsWindow = useSettingsWindow(desktopStore, settingsActions.syncAutostartEnabled);
const workspaceStartup = useWorkspaceStartup();
const settingsPlugins = useSettingsPlugins();
const settingsStartup = useSettingsStartup(
  desktopStore,
  settingsActions.syncAutostartEnabled,
  settingsBoxes.createAndOpenBox,
  (enabled) => {
    settingsActions.autostartEnabled.value = enabled;
  },
  // 工作区快捷方式启动时保持设置窗可见，否则用户看不到还原进度。
  // 用回调而非布尔值，让判断发生在实际恢复完成的那一刻。
  () => Boolean(workspaceStartup.requestedWorkspaceId.value),
);

/**
 * 设置页启动时注册窗口同步和托盘事件，再恢复桌面上的 Box 窗口。
 *
 * 工作区启动编排必须早于 Box 恢复：它以最快的速度判断本次是否由
 * 工作区快捷方式启动，从而决定设置窗在 Box 恢复后是否收起。
 *
 * 插件加载放在最后且不 await：插件是第三方代码，激活耗时不可控，
 * 更不能因为某个插件卡住就让 Box 恢复与设置窗显示一起等下去。
 */
onMounted(async () => {
  await settingsWindow.bindFocusSync();
  const startupWorkspaceId = await workspaceStartup.initializeWorkspaceStartup();
  if (startupWorkspaceId) {
    activeSection.value = "workspace";
  }
  await settingsStartup.initializeSettingsStartup();
  void settingsPlugins.initializePlugins();
});

/**
 * 组件销毁时注销窗口和托盘事件，避免开发热更新后重复刷新状态。
 */
onUnmounted(() => {
  settingsWindow.disposeSettingsWindow();
  settingsStartup.disposeSettingsStartup();
  workspaceStartup.disposeWorkspaceStartup();
});

/**
 * 切换设置面板前先同步复位共享滚动容器，避免旧面板底部滚动位置参与新面板进入动画。
 *
 * 右侧内容区由多个设置面板共用同一个滚动容器；如果先换 key 再等浏览器根据新内容高度修正
 * scrollTop，用户会看到面板已经开始过渡后又突然跳到顶部。这里在状态变更前复位，让过渡首帧
 * 就落在新面板顶部，同时保留点击当前菜单时的阅读位置。
 */
function changeActiveSection(section: SettingsSection): void {
  if (section === activeSection.value) {
    return;
  }

  if (settingsScrollArea.value) {
    settingsScrollArea.value.scrollTop = 0;
    settingsScrollArea.value.scrollLeft = 0;
  }

  activeSection.value = section;
}
</script>

<template>
  <main class="settings-window h-screen w-screen overflow-hidden bg-transparent text-[#17181c] dark:text-[#f4f4f5]">
    <section class="flex h-full w-full overflow-hidden bg-[#f7f7f9] shadow-[0_16px_36px_rgba(20,24,32,0.16)] ring-1 ring-inset ring-[#d7dae2] dark:bg-[#15161b] dark:shadow-[0_16px_36px_rgba(0,0,0,0.34)] dark:ring-[#2b2e36]">
      <SettingsSidebar
        :active-section="activeSection"
        :sections="SETTINGS_SECTIONS"
        @section-change="changeActiveSection"
      />

      <section class="flex min-w-0 flex-1 flex-col bg-[#fbfbfd] dark:bg-[#101116]">
        <SettingsHeader
          :title="activeTitle"
          @close="settingsWindow.closeSettings"
          @drag-start="settingsWindow.startDragging"
          @minimize="settingsWindow.minimizeSettings"
          @toggle-maximize="settingsWindow.toggleSettingsMaximize"
        />

        <div ref="settingsScrollArea" class="dasktop-scrollarea min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
          <div
            v-if="settingsStartup.startupError.value"
            class="mx-8 mt-6 rounded-[12px] border border-[#f0c7c7] bg-[#fff6f6] px-4 py-3 text-[13px] text-[#9f1d1d] dark:border-[#5b2a2d] dark:bg-[#281619] dark:text-[#ffb4b4]"
          >
            Box 启动失败：{{ settingsStartup.startupError.value }}
          </div>

          <div
            v-if="workspaceStartup.startupError.value"
            class="mx-8 mt-6 rounded-[12px] border border-[#f0c7c7] bg-[#fff6f6] px-4 py-3 text-[13px] text-[#9f1d1d] dark:border-[#5b2a2d] dark:bg-[#281619] dark:text-[#ffb4b4]"
          >
            工作区还原失败：{{ workspaceStartup.startupError.value }}
          </div>

          <div class="settings-panel-stack min-h-full">
            <Transition name="settings-panel">
              <div :key="activeSection" class="settings-panel-transition min-h-full">
                <BoxesPanel
                  v-if="activeSection === 'boxes'"
                  :boxes="desktopStore.boxes"
                  :collection-root-path="desktopStore.settings.collectionRootPath"
                  :migratable-box-count="settingsActions.migratableBoxCount.value"
                  :migration-busy="settingsActions.isMigratingCollectionRoot.value"
                  :panel-width="SETTINGS_PANEL_WIDTH.default"
                  @collection-root-choose="settingsActions.chooseCollectionRootFromSettings"
                  @collection-root-migrate="settingsActions.migrateCollectionRootFromSettings"
                  @collection-root-open="settingsActions.openCollectionRootFromSettings"
                  @create-box="settingsBoxes.createAndOpenBox"
                  @delete-box="settingsBoxes.deleteBoxFromSettings"
                  @open-box="settingsBoxes.openBoxWindow"
                  @open-folder="settingsBoxes.openBoxFolderFromSettings"
                  @refresh="desktopStore.refreshSnapshot"
                  @toggle-box-locked="settingsBoxes.toggleBoxLockedFromSettings"
                />
                <WorkspacePanel
                  v-else-if="activeSection === 'workspace'"
                  :desktop-path="desktopStore.desktopPath"
                  :panel-width="SETTINGS_PANEL_WIDTH.default"
                  :startup-results="workspaceStartup.startupResults.value"
                />
                <FilePanel
                  v-else-if="activeSection === 'file'"
                  :panel-width="SETTINGS_PANEL_WIDTH.default"
                  :settings="desktopStore.settings"
                  @box-boolean-setting-change="desktopStore.updateBooleanSetting"
                  @box-conflict-policy-change="desktopStore.updateBoxConflictPolicy"
                  @box-delete-policy-change="desktopStore.updateBoxDeletePolicy"
                  @box-drag-out-action-change="desktopStore.updateBoxDragOutAction"
                  @box-drop-action-change="desktopStore.updateBoxDropAction"
                  @name-display-mode-change="desktopStore.updateNameDisplayMode"
                />
                <WindowPanel
                  v-else-if="activeSection === 'window'"
                  :autostart-enabled="settingsActions.autostartEnabled.value"
                  :panel-width="SETTINGS_PANEL_WIDTH.default"
                  :settings="desktopStore.settings"
                  @autostart-enabled-change="settingsActions.updateAutostartEnabled"
                  @box-boolean-setting-change="desktopStore.updateBooleanSetting"
                  @snap-threshold-change="desktopStore.updateSnapThreshold"
                  @snap-to-edges-change="desktopStore.updateSnapToEdges"
                />
                <AppearancePanel
                  v-else-if="activeSection === 'appearance'"
                  :panel-width="SETTINGS_PANEL_WIDTH.default"
                  :settings="desktopStore.settings"
                  @box-theme-change="desktopStore.updateBoxTheme"
                  @box-visual-setting-change="desktopStore.updateNumberSetting"
                  @settings-theme-change="desktopStore.updateSettingsTheme"
                />
                <PluginsPanel
                  v-else-if="activeSection === 'plugins'"
                  :panel-width="SETTINGS_PANEL_WIDTH.default"
                  :runtime="settingsPlugins.runtime.value"
                  @open-root="settingsPlugins.openPluginsRoot"
                  @open-ui="settingsPlugins.openPluginUi"
                  @reload="settingsPlugins.reloadPlugins"
                />
                <AboutPanel
                  v-else-if="activeSection === 'about'"
                  :desktop-path="desktopStore.desktopPath"
                  :panel-width="SETTINGS_PANEL_WIDTH.default"
                />
              </div>
            </Transition>
          </div>
        </div>
      </section>
    </section>
  </main>
</template>

<style scoped>
/**
 * 设置页是桌面工具面板，禁用文本框选可以避免拖拽窗口和点击控件时误选中文案。
 */
.settings-window,
.settings-window * {
  user-select: none;
  -webkit-user-select: none;
}

/**
 * 内容区切换和左侧菜单选中背景共用 200ms 曲线，避免左右两侧节奏不同导致割裂感。
 */
.settings-panel-stack {
  position: relative;
  overflow-x: clip;
}

.settings-panel-transition {
  min-width: 0;
}

/**
 * 离场面板脱离文档流，避免新旧内容交叉淡入时把滚动区域临时撑高。
 */
.settings-panel-enter-active,
.settings-panel-leave-active {
  transition:
    opacity 200ms cubic-bezier(0.22, 1, 0.36, 1),
    transform 200ms cubic-bezier(0.22, 1, 0.36, 1);
}

.settings-panel-leave-active {
  left: 0;
  pointer-events: none;
  position: absolute;
  right: 0;
  top: 0;
}

.settings-panel-enter-from {
  opacity: 0;
  transform: translateX(4px);
}

.settings-panel-leave-to {
  opacity: 0;
  transform: translateX(-4px);
}

/**
 * 尊重系统减少动态效果设置，保留即时切换，避免辅助功能用户看到额外位移。
 */
@media (prefers-reduced-motion: reduce) {
  .settings-panel-enter-active,
  .settings-panel-leave-active {
    transition-duration: 1ms;
  }

  .settings-panel-enter-from,
  .settings-panel-leave-to {
    transform: none;
  }
}
</style>
