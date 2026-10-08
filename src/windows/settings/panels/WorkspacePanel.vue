<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Layers,
  Link2,
  Play,
  Plus,
  RotateCcw,
  Trash2,
  XCircle,
} from "@lucide/vue";
import { useWorkspaceStore } from "@/entities/workspace/store";
import type { WorkspaceRestoreResult, WorkspaceWindow } from "@/entities/workspace/types";
import SettingGroup from "../components/SettingGroup.vue";
import SettingSection from "../components/SettingSection.vue";

/**
 * 工作区面板按 PowerToys Workspaces 的使用流程组织：
 * 捕获当前桌面布局保存为工作区，之后一键启动即可还原应用窗口位置。
 */
const props = defineProps<{
  desktopPath: string;
  panelWidth: string;
  /**
   * 快捷方式启动时由根组件注入的还原结果。
   *
   * 启动编排已上移到根组件，面板只负责展示；为空表示本次不是快捷方式启动。
   */
  startupResults?: WorkspaceRestoreResult[];
}>();

const workspaceStore = useWorkspaceStore();
const isCapturing = ref(false);
const captureError = ref("");
const statusMessage = ref("");
const expandedWorkspaceId = ref("");

/**
 * 列表行内图标叠放的最大展示数量。
 *
 * 超过该数量后用「+N」汇总，避免窗口数很多时把工作区名称挤到看不见。
 */
const ICON_PREVIEW_LIMIT = 5;

/**
 * 启动状态弹窗的应用条目，承载每个应用的实时进度。
 */
interface RestoreProgressItem {
  executablePath: string;
  label: string;
  message: string;
  status: "pending" | "success" | "reused" | "failed";
}

/**
 * 弹窗条目的图标。
 *
 * 构造条目时快照一次，避免弹窗展示期间出现图标异步补齐导致的跳动。
 */
const restoreDialogIcons = ref<Record<string, string>>({});

const restoreDialog = ref<{
  items: RestoreProgressItem[];
  visible: boolean;
  workspaceName: string;
}>({
  items: [],
  visible: false,
  workspaceName: "",
});

/**
 * 每个工作区的应用数量用于列表摘要，避免用户展开才能看到工作区规模。
 */
const workspaceSummaries = computed(() =>
  workspaceStore.workspaces.map((workspace) => ({
    ...workspace,
    appCount: workspace.windows.length,
  })),
);

const restoreSuccessCount = computed(
  () => restoreDialog.value.items.filter((item) => item.status === "success").length,
);
const restoreReusedCount = computed(
  () => restoreDialog.value.items.filter((item) => item.status === "reused").length,
);
const restoreFailedCount = computed(
  () => restoreDialog.value.items.filter((item) => item.status === "failed").length,
);
const restoreFinished = computed(
  () => restoreDialog.value.items.every((item) => item.status !== "pending"),
);

/**
 * 快捷方式启动还原结果的一行提示。
 *
 * 与手动点击「启动」不同，这条路径由根组件编排、面板只是展示方，
 * 因此文案独立计算，避免与用户操作产生的 statusMessage 相互覆盖。
 */
const startupResultMessage = computed(() => {
  const results = props.startupResults;
  if (!results || results.length === 0) {
    return "";
  }

  const failedCount = results.filter((result) => !result.success).length;

  return failedCount > 0
    ? `已启动工作区，其中 ${failedCount} 个应用未能定位`
    : `已启动工作区，共还原 ${results.length} 个应用`;
});

onMounted(async () => {
  await workspaceStore.initializeWorkspaces();
});

onUnmounted(() => {
  // 启动还原编排已上移到设置页根组件（useWorkspaceStartup），
  // 面板不再直接注册启动事件监听。
});

/**
 * 从可执行文件路径提取应用名，作为界面展示的兜底名称。
 */
function resolveAppLabel(window: WorkspaceWindow): string {
  const fileName = window.executablePath.split(/[\\/]/).pop() ?? window.executablePath;

  return fileName.replace(/\.exe$/i, "");
}

/**
 * 取应用图标；Shell 解析失败时返回空串，模板据此回退到首字母占位块。
 */
function resolveAppIcon(window: WorkspaceWindow): string {
  return workspaceStore.executableIcons[window.executablePath] ?? "";
}

/**
 * 取应用名首字符作为无图标时的占位内容。
 */
function resolveAppInitial(window: WorkspaceWindow): string {
  return resolveAppLabel(window).charAt(0).toUpperCase();
}

/**
 * 捕获当前桌面布局，成功后把新工作区名称填入输入框便于继续调整。
 */
async function captureCurrentLayout(): Promise<void> {
  isCapturing.value = true;
  captureError.value = "";
  statusMessage.value = "";

  try {
    const workspace = await workspaceStore.captureAsWorkspace(
      `工作区 ${workspaceStore.workspaces.length + 1}`,
    );

    if (workspace.windows.length === 0) {
      statusMessage.value = "未捕获到任何应用窗口，请先打开需要纳入工作区的应用";
      return;
    }

    statusMessage.value = `已捕获 ${workspace.windows.length} 个应用窗口`;
  } catch (error) {
    captureError.value = String(error);
  } finally {
    isCapturing.value = false;
  }
}

/**
 * 启动工作区并以弹窗展示每个应用的实时状态。
 *
 * 窗口定位由后端逐个轮询完成，这里在发起请求前先把全部应用标记为处理中，
 * 让用户看到完整清单和进度，而不是等待结束后才知道结果。
 */
async function launchWorkspace(workspaceId: string): Promise<void> {
  const workspace = workspaceStore.workspaces.find((item) => item.id === workspaceId);
  if (!workspace) {
    return;
  }

  statusMessage.value = "";
  captureError.value = "";
  restoreDialog.value = {
    items: workspace.windows.map((window) => ({
      executablePath: window.executablePath,
      label: resolveAppLabel(window),
      message: "",
      status: "pending" as const,
    })),
    visible: true,
    workspaceName: workspace.name,
  };
  restoreDialogIcons.value = Object.fromEntries(
    workspace.windows.map((window) => [window.executablePath, resolveAppIcon(window)]),
  );

  try {
    const results = await workspaceStore.launchWorkspace(workspaceId);

    // 后端按顺序返回结果，逐项映射状态；缺失项保持 pending 以暴露异常。
    restoreDialog.value = {
      ...restoreDialog.value,
      items: restoreDialog.value.items.map((item) => {
        const matched = results.find(
          (result) => result.executablePath.toLowerCase() === item.executablePath.toLowerCase(),
        );

        if (!matched) {
          return { ...item, message: "未返回处理结果", status: "failed" as const };
        }

        if (!matched.success) {
          return { ...item, message: matched.message, status: "failed" as const };
        }

        return {
          ...item,
          message: matched.reusedExisting ? "已移动到目标位置（复用现有窗口）" : "已启动并移动到位",
          status: matched.reusedExisting ? ("reused" as const) : ("success" as const),
        };
      }),
    };
  } catch (error) {
    captureError.value = String(error);
    restoreDialog.value = {
      ...restoreDialog.value,
      items: restoreDialog.value.items.map((item) =>
        item.status === "pending"
          ? { ...item, message: String(error), status: "failed" as const }
          : item,
      ),
    };
  }
}

function closeRestoreDialog(): void {
  restoreDialog.value = { items: [], visible: false, workspaceName: "" };
}

/**
 * 重命名工作区，空名称回退到原名避免产生无法辨认的条目。
 */
async function renameWorkspace(workspaceId: string, event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const nextName = input.value.trim();
  if (!nextName) {
    input.value = workspaceStore.workspaces.find((item) => item.id === workspaceId)?.name ?? "";
    return;
  }

  await workspaceStore.renameWorkspace(workspaceId, nextName);
}

/**
 * 用当前桌面布局覆盖工作区，保留名称便于反复调整到满意为止。
 */
async function recaptureWorkspace(workspaceId: string): Promise<void> {
  statusMessage.value = "";

  try {
    const windows = await workspaceStore.recaptureWorkspace(workspaceId);
    statusMessage.value = `已更新为 ${windows.length} 个应用窗口`;
  } catch (error) {
    captureError.value = String(error);
  }
}

async function removeWorkspace(workspaceId: string): Promise<void> {
  await workspaceStore.removeWorkspace(workspaceId);
  statusMessage.value = "工作区已删除";
}

/**
 * 创建工作区桌面快捷方式，可直接固定到任务栏。
 */
async function createDesktopShortcut(workspaceId: string): Promise<void> {
  statusMessage.value = "";
  captureError.value = "";

  try {
    await workspaceStore.createDesktopShortcut(workspaceId, props.desktopPath);
    statusMessage.value = "已在桌面创建快捷方式，可右键固定到任务栏";
  } catch (error) {
    captureError.value = String(error);
  }
}

/**
 * 展开或收起工作区的应用参数编辑区。
 */
function toggleWorkspaceExpanded(workspaceId: string): void {
  expandedWorkspaceId.value = expandedWorkspaceId.value === workspaceId ? "" : workspaceId;
}

/**
 * 应用参数输入框失焦时保存，保持与名称重命名一致的交互节奏。
 */
async function updateWindowArguments(
  workspaceId: string,
  executablePath: string,
  event: Event,
): Promise<void> {
  const input = event.target as HTMLInputElement;
  await workspaceStore.updateWindowArguments(workspaceId, executablePath, input.value.trim());
}
</script>

<template>
  <SettingSection
    description="捕获桌面上的应用窗口布局，之后一键还原到保存时的位置和大小"
    :panel-width="props.panelWidth"
    title="工作区"
  >
    <SettingGroup>
      <div class="flex items-start gap-3 px-5 py-5">
        <div class="min-w-0 flex-1">
          <h2 class="text-[13px] font-semibold text-[#202229] dark:text-[#f4f4f5]">
            捕获当前桌面
          </h2>
          <p class="mt-1 text-[12px] leading-5 text-[#707684] dark:text-[#9ca0aa]">
            先把应用打开并摆放成想要的布局，再点击捕获。Dasktop 会记录每个应用的位置和大小。
          </p>
        </div>
        <button
          class="flex shrink-0 items-center gap-1.5 rounded-[8px] bg-[#ff5c5c] px-3 py-2 text-[12px] font-medium text-white transition-opacity duration-200 disabled:opacity-50"
          type="button"
          :disabled="isCapturing"
          @click="captureCurrentLayout"
        >
          <Plus :size="14" />
          {{ isCapturing ? "捕获中…" : "创建工作区" }}
        </button>
      </div>
    </SettingGroup>

    <div
      v-if="captureError"
      class="mt-4 rounded-[10px] border border-[#f0c7c7] bg-[#fff6f6] px-4 py-3 text-[12px] text-[#9f1d1d] dark:border-[#5b2a2d] dark:bg-[#281619] dark:text-[#ffb4b4]"
    >
      {{ captureError }}
    </div>

    <div
      v-else-if="statusMessage || startupResultMessage"
      class="mt-4 rounded-[10px] border border-[#cfdfd0] bg-[#f5fbf5] px-4 py-3 text-[12px] text-[#2f6b34] dark:border-[#2c4630] dark:bg-[#16241a] dark:text-[#9ad6a1]"
    >
      {{ statusMessage || startupResultMessage }}
    </div>

    <SettingGroup class="mt-4">
      <div
        v-if="workspaceSummaries.length === 0"
        class="flex flex-col items-center gap-2 px-5 py-12 text-center"
      >
        <Layers :size="28" class="text-[#b9bdc7] dark:text-[#5a5e68]" />
        <p class="text-[13px] text-[#6f7480] dark:text-[#a7abb5]">还没有工作区</p>
        <p class="text-[12px] text-[#9aa0ab] dark:text-[#7d828c]">
          打开需要用的应用并摆好位置，然后点击「创建工作区」
        </p>
      </div>

      <template v-else>
        <div
          v-for="(workspace, index) in workspaceSummaries"
          :key="workspace.id"
          :class="index > 0 ? 'border-t border-[#e7e9ee] dark:border-[#292c34]' : ''"
        >
          <div class="flex items-center gap-3 px-5 py-4">
            <!-- 应用图标叠放预览，让用户不展开也能认出这个工作区包含哪些应用 -->
            <div
              v-if="workspace.windows.length > 0"
              class="flex shrink-0 items-center -space-x-1.5"
            >
              <template
                v-for="window in workspace.windows.slice(0, ICON_PREVIEW_LIMIT)"
                :key="window.executablePath"
              >
                <img
                  v-if="resolveAppIcon(window)"
                  class="size-7 rounded-[6px] border border-[#e7e9ee] bg-white object-contain p-0.5 dark:border-[#33363e] dark:bg-[#22252b]"
                  :src="resolveAppIcon(window)"
                  :title="resolveAppLabel(window)"
                  alt=""
                />
                <span
                  v-else
                  class="grid size-7 place-items-center rounded-[6px] border border-[#e7e9ee] bg-[#f1f3f7] text-[11px] font-semibold text-[#7d828c] dark:border-[#33363e] dark:bg-[#2a2d35] dark:text-[#9ca0aa]"
                  :title="resolveAppLabel(window)"
                >
                  {{ resolveAppInitial(window) }}
                </span>
              </template>
              <span
                v-if="workspace.windows.length > ICON_PREVIEW_LIMIT"
                class="grid size-7 place-items-center rounded-[6px] border border-[#e7e9ee] bg-[#f1f3f7] text-[10px] font-semibold text-[#7d828c] dark:border-[#33363e] dark:bg-[#2a2d35] dark:text-[#9ca0aa]"
                :title="`还有 ${workspace.windows.length - ICON_PREVIEW_LIMIT} 个应用`"
              >
                +{{ workspace.windows.length - ICON_PREVIEW_LIMIT }}
              </span>
            </div>

            <input
              class="min-w-0 flex-1 rounded-[6px] border border-transparent bg-transparent px-1 py-0.5 text-[13px] font-semibold text-[#202229] outline-none transition-colors duration-200 hover:border-[#dfe2e8] focus:border-[#ff5c5c] dark:text-[#f4f4f5] dark:hover:border-[#3a3d46]"
              :value="workspace.name"
              @blur="renameWorkspace(workspace.id, $event)"
              @keydown.enter="($event.target as HTMLInputElement).blur()"
            />

            <div class="flex shrink-0 items-center gap-1.5">
              <button
                class="flex items-center gap-1.5 rounded-[8px] bg-[#ff5c5c] px-2.5 py-1.5 text-[12px] font-medium text-white transition-opacity duration-200 disabled:opacity-50"
                type="button"
                :disabled="workspaceStore.isBusy"
                @click="launchWorkspace(workspace.id)"
              >
                <Play :size="13" />
                启动
              </button>
              <button
                class="grid size-8 place-items-center rounded-[8px] bg-[#eef0f4] text-[#5c626e] transition-colors duration-200 hover:bg-[#e3e5eb] disabled:opacity-50 dark:bg-[#23262d] dark:text-[#a7abb5] dark:hover:bg-[#2a2d35]"
                type="button"
                title="创建桌面快捷方式"
                @click="createDesktopShortcut(workspace.id)"
              >
                <Link2 :size="14" />
              </button>
              <button
                class="grid size-8 place-items-center rounded-[8px] bg-[#eef0f4] text-[#5c626e] transition-colors duration-200 hover:bg-[#e3e5eb] disabled:opacity-50 dark:bg-[#23262d] dark:text-[#a7abb5] dark:hover:bg-[#2a2d35]"
                type="button"
                title="用当前布局重新捕获"
                :disabled="workspaceStore.isBusy"
                @click="recaptureWorkspace(workspace.id)"
              >
                <RotateCcw :size="14" />
              </button>
              <button
                class="grid size-8 place-items-center rounded-[8px] bg-[#eef0f4] text-[#5c626e] transition-colors duration-200 hover:bg-[#ffe3e3] hover:text-[#c33] dark:bg-[#23262d] dark:text-[#a7abb5] dark:hover:bg-[#3a2226] dark:hover:text-[#ff8f8f]"
                type="button"
                title="删除工作区"
                @click="removeWorkspace(workspace.id)"
              >
                <Trash2 :size="14" />
              </button>
            </div>
          </div>

          <div class="flex items-center gap-2 px-5 pb-3">
            <button
              class="flex items-center gap-1 text-[12px] text-[#8b909b] transition-colors duration-200 hover:text-[#5c626e] dark:text-[#7d828c] dark:hover:text-[#a7abb5]"
              type="button"
              @click="toggleWorkspaceExpanded(workspace.id)"
            >
              <ChevronDown
                :size="13"
                class="transition-transform duration-200"
                :class="expandedWorkspaceId === workspace.id ? 'rotate-180' : ''"
              />
              {{ workspace.appCount }} 个应用窗口
            </button>
          </div>

          <div
            v-if="expandedWorkspaceId === workspace.id"
            class="border-t border-[#f0f1f4] px-5 py-3 dark:border-[#23262d]"
          >
            <p class="mb-2 text-[12px] text-[#8b909b] dark:text-[#7d828c]">
              启动参数用于控制多实例应用的启动行为（如 VS Code 的 --reuse-window）；
              勾选「最小化」会让该应用还原到指定位置后自动收起
            </p>
            <div class="grid gap-2">
              <div
                v-for="window in workspace.windows"
                :key="window.executablePath"
                class="grid grid-cols-[150px_1fr_auto_auto] items-center gap-2.5"
              >
                <span
                  class="flex min-w-0 items-center gap-1.5 text-[12px] text-[#5c626e] dark:text-[#a7abb5]"
                  :title="window.executablePath"
                >
                  <img
                    v-if="resolveAppIcon(window)"
                    class="size-4 shrink-0 rounded-[3px] object-contain"
                    :src="resolveAppIcon(window)"
                    alt=""
                  />
                  <span
                    v-else
                    class="grid size-4 shrink-0 place-items-center rounded-[3px] bg-[#f1f3f7] text-[9px] font-semibold text-[#7d828c] dark:bg-[#2a2d35] dark:text-[#9ca0aa]"
                  >
                    {{ resolveAppInitial(window) }}
                  </span>
                  <span class="truncate">{{ resolveAppLabel(window) }}</span>
                </span>
                <input
                  class="min-w-0 rounded-[6px] border border-[#dfe2e8] bg-[#fbfbfd] px-2 py-1 text-[12px] text-[#202229] outline-none transition-colors duration-200 focus:border-[#ff5c5c] dark:border-[#3a3d46] dark:bg-[#1c1e24] dark:text-[#f4f4f5]"
                  placeholder="启动参数（可选）"
                  :value="window.arguments"
                  @blur="updateWindowArguments(workspace.id, window.executablePath, $event)"
                  @keydown.enter="($event.target as HTMLInputElement).blur()"
                />
                <label
                  class="flex cursor-pointer select-none items-center gap-1.5 text-[11px] whitespace-nowrap"
                  :class="
                    window.minimized
                      ? 'text-[#c33] dark:text-[#ff8f8f]'
                      : 'text-[#8b909b] dark:text-[#7d828c]'
                  "
                  :title="window.minimized ? '还原后保持最小化（取消勾选则正常显示）' : '还原后保持最小化'"
                >
                  <input
                    class="size-3.5 cursor-pointer accent-[#ff5c5c]"
                    type="checkbox"
                    :checked="window.minimized"
                    @change="
                      workspaceStore.setWindowMinimized(
                        workspace.id,
                        window.executablePath,
                        ($event.target as HTMLInputElement).checked,
                      )
                    "
                  />
                  最小化
                </label>
                <button
                  class="grid size-7 place-items-center rounded-[6px] text-[#8b909b] transition-colors duration-200 hover:bg-[#ffe3e3] hover:text-[#c33] dark:text-[#7d828c] dark:hover:bg-[#3a2226] dark:hover:text-[#ff8f8f]"
                  type="button"
                  title="从工作区移除该应用"
                  @click="workspaceStore.removeWindow(workspace.id, window.executablePath)"
                >
                  <XCircle :size="13" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </template>
    </SettingGroup>
  </SettingSection>

  <Teleport to="body">
    <div
      v-if="restoreDialog.visible"
      class="fixed inset-0 z-50 grid place-items-center bg-[rgba(12,14,18,0.42)] px-6"
    >
      <div
        class="w-full max-w-[420px] overflow-hidden rounded-[12px] border border-[#dfe2e8] bg-[#ffffff] shadow-[0_20px_48px_rgba(20,24,32,0.24)] dark:border-[#2b2e36] dark:bg-[#181a20]"
      >
        <div class="border-b border-[#e7e9ee] px-5 py-4 dark:border-[#292c34]">
          <h2 class="text-[14px] font-semibold text-[#202229] dark:text-[#f4f4f5]">
            正在启动 {{ restoreDialog.workspaceName }}
          </h2>
          <p class="mt-1 text-[12px] text-[#707684] dark:text-[#9ca0aa]">
            {{
              restoreFinished
                ? `完成：${restoreSuccessCount} 个新建，${restoreReusedCount} 个复用，${restoreFailedCount} 个失败`
                : "Dasktop 正在逐个启动应用并移动到保存位置"
            }}
          </p>
        </div>

        <div class="dasktop-scrollarea max-h-[300px] overflow-y-auto px-5 py-3">
          <div
            v-for="item in restoreDialog.items"
            :key="item.executablePath"
            class="flex items-start gap-2.5 py-2"
          >
            <img
              v-if="restoreDialogIcons[item.executablePath]"
              class="mt-0.5 size-4 shrink-0 rounded-[3px] object-contain"
              :src="restoreDialogIcons[item.executablePath]"
              alt=""
            />
            <span v-else class="mt-0.5 shrink-0">
              <span
                v-if="item.status === 'pending'"
                class="block size-3.5 animate-spin rounded-full border-2 border-[#d7dae2] border-t-[#ff5c5c] dark:border-[#3a3d46] dark:border-t-[#ff5c5c]"
              />
              <CheckCircle2
                v-else-if="item.status === 'success'"
                :size="14"
                class="text-[#3f9d47] dark:text-[#63c46c]"
              />
              <RotateCcw
                v-else-if="item.status === 'reused'"
                :size="14"
                class="text-[#3d7fc1] dark:text-[#6aa9e8]"
              />
              <AlertCircle v-else :size="14" class="text-[#c33] dark:text-[#ff8f8f]" />
            </span>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5">
                <span class="truncate text-[12px] font-medium text-[#202229] dark:text-[#f4f4f5]">
                  {{ item.label }}
                </span>
                <!-- 有图标时状态指示器移到名称右侧，避免与图标抢占同一位置 -->
                <span v-if="restoreDialogIcons[item.executablePath]" class="shrink-0">
                  <span
                    v-if="item.status === 'pending'"
                    class="block size-3 animate-spin rounded-full border-2 border-[#d7dae2] border-t-[#ff5c5c] dark:border-[#3a3d46] dark:border-t-[#ff5c5c]"
                  />
                  <CheckCircle2
                    v-else-if="item.status === 'success'"
                    :size="13"
                    class="text-[#3f9d47] dark:text-[#63c46c]"
                  />
                  <RotateCcw
                    v-else-if="item.status === 'reused'"
                    :size="13"
                    class="text-[#3d7fc1] dark:text-[#6aa9e8]"
                  />
                  <AlertCircle v-else :size="13" class="text-[#c33] dark:text-[#ff8f8f]" />
                </span>
              </div>
              <div
                v-if="item.message"
                class="mt-0.5 text-[11px] leading-4 text-[#8b909b] dark:text-[#7d828c]"
              >
                {{ item.message }}
              </div>
            </div>
          </div>
        </div>

        <div class="flex justify-end border-t border-[#e7e9ee] px-5 py-3 dark:border-[#292c34]">
          <button
            class="rounded-[8px] bg-[#eef0f4] px-3 py-1.5 text-[12px] font-medium text-[#5c626e] transition-colors duration-200 hover:bg-[#e3e5eb] dark:bg-[#23262d] dark:text-[#a7abb5] dark:hover:bg-[#2a2d35]"
            type="button"
            @click="closeRestoreDialog"
          >
            {{ restoreFinished ? "关闭" : "后台继续" }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
