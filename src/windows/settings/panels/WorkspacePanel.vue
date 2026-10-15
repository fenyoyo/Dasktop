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
import type {
  WorkspaceRestoreResult,
  WorkspaceRestoreStatus,
  WorkspaceWindow,
} from "@/entities/workspace/types";
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
 * 「添加命令」输入框的草稿内容。
 *
 * 同一时刻只有一个工作区处于展开态，因此用单个草稿字段即可，
 * 不必按工作区分别保存。
 */
const newCommandDraft = ref("");

/**
 * 列表行内图标叠放的最大展示数量。
 *
 * 超过该数量后用「+N」汇总，避免窗口数很多时把工作区名称挤到看不见。
 */
const ICON_PREVIEW_LIMIT = 5;

/**
 * 启动状态弹窗的条目，应用与附加命令共用同一套展示结构。
 */
interface RestoreProgressItem {
  /**
   * 条目身份，同时作为列表 key 与图标缓存的键。
   *
   * 应用条目用可执行文件路径，命令条目用 `command:<下标>`；
   * 两类取值空间不重叠，因此可以放在同一个字段里。
   */
  key: string;
  /**
   * 条目类型，决定结果如何映射回后端返回值：
   * 应用按可执行文件路径匹配，命令按填写顺序匹配。
   */
  kind: "window" | "command";
  label: string;
  message: string;
  status: WorkspaceRestoreStatus;
}

/**
 * 弹窗条目的图标，键与条目的 key 一致。
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

/**
 * 应用条目的状态统计。
 *
 * 与命令条目分开计数：应用关心「窗口是否就位」，命令关心「退出码是否为 0」，
 * 两类数字含义不同，混在一起用户无法判断到底哪部分出了问题。
 */
const restoreAppCounts = computed(() => {
  const appItems = restoreDialog.value.items.filter(
    (item) => item.kind === "window",
  );

  return {
    failed: appItems.filter((item) => item.status === "failed").length,
    reused: appItems.filter((item) => item.status === "reused").length,
    success: appItems.filter((item) => item.status === "success").length,
  };
});

/**
 * 命令条目的状态统计，命令只有成功与失败两态。
 */
const restoreCommandCounts = computed(() => {
  const commandItems = restoreDialog.value.items.filter(
    (item) => item.kind === "command",
  );

  return {
    failed: commandItems.filter((item) => item.status === "failed").length,
    total: commandItems.length,
  };
});

const restoreFinished = computed(() =>
  restoreDialog.value.items.every((item) => item.status !== "pending"),
);

/**
 * 完成后的状态摘要。
 *
 * 没有配置附加命令时保持原来的单句文案，配置了才追加命令统计，
 * 避免大多数工作区都拖着一句无意义的「0 条命令」。
 */
const restoreSummary = computed(() => {
  const apps = restoreAppCounts.value;
  const commands = restoreCommandCounts.value;

  const appSummary = `${apps.success} 个新建，${apps.reused} 个复用，${apps.failed} 个失败`;
  if (commands.total === 0) {
    return `完成：${appSummary}`;
  }

  return `完成：应用 ${appSummary}；命令 ${commands.total - commands.failed} 条成功，${commands.failed} 条失败`;
});

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
  const fileName =
    window.executablePath.split(/[\\/]/).pop() ?? window.executablePath;

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
      statusMessage.value =
        "未捕获到任何应用窗口，请先打开需要纳入工作区的应用；只驻留托盘的程序要先点开它的窗口";
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
 * 启动工作区并以弹窗展示每个应用、每条附加命令的实时状态。
 *
 * 实际执行由后端串行完成，这里在发起请求前先把全部条目标记为处理中，
 * 让用户看到完整清单和进度，而不是等待结束后才知道结果。
 */
async function launchWorkspace(workspaceId: string): Promise<void> {
  const workspace = workspaceStore.workspaces.find(
    (item) => item.id === workspaceId,
  );
  if (!workspace) {
    return;
  }

  statusMessage.value = "";
  captureError.value = "";

  // 命令条目排在被还原的应用之后，与后端「先还原应用、再顺序执行命令」
  // 的顺序一致，用户能直接把进度和列表对上。
  const items: RestoreProgressItem[] = [
    ...workspace.windows.map((window) => ({
      key: window.executablePath,
      kind: "window" as const,
      label: resolveAppLabel(window),
      message: "",
      status: "pending" as const,
    })),
    ...workspace.commands.map((command, index) => ({
      key: `command:${index}`,
      kind: "command" as const,
      label: command,
      message: "",
      status: "pending" as const,
    })),
  ];

  restoreDialog.value = {
    items,
    visible: true,
    workspaceName: workspace.name,
  };
  restoreDialogIcons.value = Object.fromEntries(
    workspace.windows.map((window) => [
      window.executablePath,
      resolveAppIcon(window),
    ]),
  );

  try {
    const outcome = await workspaceStore.launchWorkspace(workspaceId);

    // 应用按可执行文件路径匹配；命令按下标匹配——后端按填写顺序返回，
    // 且空命令在读写两侧都已被过滤，下标与界面条目一一对应。
    const commandResults = new Map(
      outcome.commands.map((result, index) => [`command:${index}`, result]),
    );

    restoreDialog.value = {
      ...restoreDialog.value,
      items: restoreDialog.value.items.map((item) => {
        if (item.kind === "command") {
          const matchedCommand = commandResults.get(item.key);
          if (!matchedCommand) {
            return {
              ...item,
              message: "未返回处理结果",
              status: "failed" as const,
            };
          }

          return {
            ...item,
            message: matchedCommand.message,
            status: matchedCommand.success
              ? ("success" as const)
              : ("failed" as const),
          };
        }

        const matched = outcome.windows.find(
          (result) =>
            result.executablePath.toLowerCase() === item.key.toLowerCase(),
        );

        if (!matched) {
          return {
            ...item,
            message: "未返回处理结果",
            status: "failed" as const,
          };
        }

        if (!matched.success) {
          return {
            ...item,
            message: matched.message,
            status: "failed" as const,
          };
        }

        return {
          ...item,
          message: matched.reusedExisting
            ? "已移动到目标位置（复用现有窗口）"
            : "已启动并移动到位",
          status: matched.reusedExisting
            ? ("reused" as const)
            : ("success" as const),
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
async function renameWorkspace(
  workspaceId: string,
  event: Event,
): Promise<void> {
  const input = event.target as HTMLInputElement;
  const nextName = input.value.trim();
  if (!nextName) {
    input.value =
      workspaceStore.workspaces.find((item) => item.id === workspaceId)?.name ??
      "";
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
  expandedWorkspaceId.value =
    expandedWorkspaceId.value === workspaceId ? "" : workspaceId;
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
  await workspaceStore.updateWindowArguments(
    workspaceId,
    executablePath,
    input.value.trim(),
  );
}

/**
 * 取指定工作区的当前命令列表。
 *
 * 命令的增删改都基于最新列表重新构造，因此每次操作前都重新读取，
 * 避免闭包里握着已经过期的副本。
 */
function readWorkspaceCommands(workspaceId: string): string[] | null {
  return (
    workspaceStore.workspaces.find((item) => item.id === workspaceId)
      ?.commands ?? null
  );
}

/**
 * 把「添加命令」输入框里的内容追加到列表末尾，随后清空草稿。
 *
 * 不做去重：同一条命令按顺序执行两次是有意义的用法（例如先停再起），
 * 交给用户自己判断。
 */
async function addCommand(workspaceId: string): Promise<void> {
  const draft = newCommandDraft.value.trim();
  if (!draft) {
    return;
  }

  const commands = readWorkspaceCommands(workspaceId);
  if (!commands) {
    return;
  }

  await workspaceStore.updateCommands(workspaceId, [...commands, draft]);
  newCommandDraft.value = "";
}

/**
 * 命令输入框失焦时保存。
 *
 * 清空输入框视为放弃修改并恢复原值，删除要走右侧的删除按钮，
 * 与工作区重命名的处理方式保持一致，避免编辑过程中误删条目。
 */
async function saveCommand(
  workspaceId: string,
  index: number,
  event: Event,
): Promise<void> {
  const input = event.target as HTMLInputElement;
  const commands = readWorkspaceCommands(workspaceId);
  const nextCommand = input.value.trim();
  if (!commands || !nextCommand) {
    input.value = commands?.[index] ?? "";
    return;
  }

  const nextCommands = [...commands];
  nextCommands[index] = nextCommand;

  await workspaceStore.updateCommands(workspaceId, nextCommands);
}

/**
 * 删除指定下标的附加命令。
 */
async function removeCommand(
  workspaceId: string,
  index: number,
): Promise<void> {
  const commands = readWorkspaceCommands(workspaceId);
  if (!commands) {
    return;
  }

  await workspaceStore.updateCommands(
    workspaceId,
    commands.filter((_, commandIndex) => commandIndex !== index),
  );
}

/**
 * 调整附加命令的执行顺序，`offset` 为 -1 表示上移、1 表示下移。
 *
 * 与应用的启动排序一样只交换相邻两条：一次点击只挪一行，
 * 顺序稳定且不会因为误操作彻底打乱。
 */
async function moveCommand(
  workspaceId: string,
  index: number,
  offset: number,
): Promise<void> {
  const commands = readWorkspaceCommands(workspaceId);
  if (!commands) {
    return;
  }

  const targetIndex = index + offset;
  const moved = commands[index];
  const displaced = commands[targetIndex];

  // 首行上移、末行下移取不到目标条目，按无效操作直接忽略。
  if (!moved || !displaced) {
    return;
  }

  const nextCommands = [...commands];
  nextCommands[index] = displaced;
  nextCommands[targetIndex] = moved;

  await workspaceStore.updateCommands(workspaceId, nextCommands);
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
          <h2
            class="text-[13px] font-semibold text-[#202229] dark:text-[#f4f4f5]"
          >
            捕获当前桌面
          </h2>
          <p
            class="mt-1 text-[12px] leading-5 text-[#707684] dark:text-[#9ca0aa]"
          >
            先把应用打开并摆放成想要的布局，再点击捕获，Dasktop
            会记录每个应用窗口的位置和大小。
            平时只驻留通知区域的程序（如微信、OneDrive）没有窗口，需要先点开它的窗口再捕获，
            否则不会出现在捕获结果里。
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
        <p class="text-[13px] text-[#6f7480] dark:text-[#a7abb5]">
          还没有工作区
        </p>
        <p class="text-[12px] text-[#9aa0ab] dark:text-[#7d828c]">
          打开需要用的应用并摆好位置，然后点击「创建工作区」
        </p>
      </div>

      <template v-else>
        <div
          v-for="(workspace, index) in workspaceSummaries"
          :key="workspace.id"
          :class="
            index > 0 ? 'border-t border-[#e7e9ee] dark:border-[#292c34]' : ''
          "
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
                :class="
                  expandedWorkspaceId === workspace.id ? 'rotate-180' : ''
                "
              />
              {{ workspace.appCount }} 个应用窗口
            </button>
          </div>

          <div
            v-if="expandedWorkspaceId === workspace.id"
            class="border-t border-[#f0f1f4] px-5 py-3 dark:border-[#23262d]"
          >
            <div class="mb-2 flex items-center gap-2">
              <span class="text-[12px] text-[#5c626e] dark:text-[#a7abb5]">
                启动间隔
              </span>
              <input
                class="w-16 rounded-[6px] border border-[#dfe2e8] bg-[#fbfbfd] px-2 py-1 text-[12px] text-[#202229] outline-none transition-colors duration-200 focus:border-[#ff5c5c] dark:border-[#3a3d46] dark:bg-[#1c1e24] dark:text-[#f4f4f5]"
                type="number"
                min="0"
                max="60"
                :value="workspace.launchIntervalSeconds"
                @change="
                  workspaceStore.updateLaunchInterval(
                    workspace.id,
                    Number(($event.target as HTMLInputElement).value),
                  )
                "
              />
              <span class="text-[12px] text-[#8b909b] dark:text-[#7d828c]">
                秒，相邻两次启动之间的等待，0 表示不等待
              </span>
            </div>
            <p class="mb-2 text-[12px] text-[#8b909b] dark:text-[#7d828c]">
              启动参数用于控制多实例应用的启动行为（如 VS Code 的
              --reuse-window）；
              勾选「最小化」会让该窗口还原到指定位置后自动收起，
              常驻托盘的程序（如微信、OneDrive）捕获后勾选它，就能随工作区启动并保持收起；
              用 ↑ ↓ 调整启动顺序，列表靠前的应用先启动
            </p>
            <div class="grid gap-2">
              <div
                v-for="(window, windowIndex) in workspace.windows"
                :key="window.executablePath"
                class="grid grid-cols-[auto_150px_1fr_auto_auto] items-center gap-2.5"
              >
                <span class="flex items-center gap-0.5">
                  <button
                    class="grid size-6 shrink-0 place-items-center rounded-[6px] text-[11px] text-[#8b909b] transition-colors duration-200 enabled:hover:bg-[#f1f3f7] enabled:hover:text-[#202229] disabled:cursor-not-allowed disabled:opacity-30 dark:text-[#7d828c] dark:enabled:hover:bg-[#2a2d35] dark:enabled:hover:text-[#f4f4f5]"
                    type="button"
                    title="上移一位，更早启动"
                    :disabled="windowIndex === 0"
                    @click="
                      workspaceStore.moveWindow(workspace.id, windowIndex, -1)
                    "
                  >
                    ↑
                  </button>
                  <button
                    class="grid size-6 shrink-0 place-items-center rounded-[6px] text-[11px] text-[#8b909b] transition-colors duration-200 enabled:hover:bg-[#f1f3f7] enabled:hover:text-[#202229] disabled:cursor-not-allowed disabled:opacity-30 dark:text-[#7d828c] dark:enabled:hover:bg-[#2a2d35] dark:enabled:hover:text-[#f4f4f5]"
                    type="button"
                    title="下移一位，更晚启动"
                    :disabled="windowIndex === workspace.windows.length - 1"
                    @click="
                      workspaceStore.moveWindow(workspace.id, windowIndex, 1)
                    "
                  >
                    ↓
                  </button>
                </span>
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
                  @blur="
                    updateWindowArguments(
                      workspace.id,
                      window.executablePath,
                      $event,
                    )
                  "
                  @keydown.enter="($event.target as HTMLInputElement).blur()"
                />
                <label
                  class="flex cursor-pointer select-none items-center gap-1.5 text-[11px] whitespace-nowrap"
                  :class="
                    window.minimized
                      ? 'text-[#c33] dark:text-[#ff8f8f]'
                      : 'text-[#8b909b] dark:text-[#7d828c]'
                  "
                  :title="
                    window.minimized
                      ? '还原后保持最小化（取消勾选则正常显示）'
                      : '还原后保持最小化'
                  "
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
                  @click="
                    workspaceStore.removeWindow(
                      workspace.id,
                      window.executablePath,
                    )
                  "
                >
                  <XCircle :size="13" />
                </button>
              </div>
            </div>

            <div
              class="mt-3 border-t border-[#f0f1f4] pt-3 dark:border-[#23262d]"
            >
              <div class="mb-2 flex flex-wrap items-center gap-2">
                <span
                  class="text-[12px] font-medium text-[#5c626e] dark:text-[#a7abb5]"
                >
                  附加命令
                </span>
                <span class="text-[11px] text-[#8b909b] dark:text-[#7d828c]">
                  应用全部还原完成后，按顺序用系统 cmd 逐条执行
                </span>
              </div>

              <div v-if="workspace.commands.length > 0" class="grid gap-2">
                <div
                  v-for="(command, commandIndex) in workspace.commands"
                  :key="`command-${commandIndex}`"
                  class="grid grid-cols-[auto_1fr_auto] items-center gap-2.5"
                >
                  <span class="flex items-center gap-0.5">
                    <button
                      class="grid size-6 shrink-0 place-items-center rounded-[6px] text-[11px] text-[#8b909b] transition-colors duration-200 enabled:hover:bg-[#f1f3f7] enabled:hover:text-[#202229] disabled:cursor-not-allowed disabled:opacity-30 dark:text-[#7d828c] dark:enabled:hover:bg-[#2a2d35] dark:enabled:hover:text-[#f4f4f5]"
                      type="button"
                      title="上移一条，更早执行"
                      :disabled="commandIndex === 0"
                      @click="moveCommand(workspace.id, commandIndex, -1)"
                    >
                      ↑
                    </button>
                    <button
                      class="grid size-6 shrink-0 place-items-center rounded-[6px] text-[11px] text-[#8b909b] transition-colors duration-200 enabled:hover:bg-[#f1f3f7] enabled:hover:text-[#202229] disabled:cursor-not-allowed disabled:opacity-30 dark:text-[#7d828c] dark:enabled:hover:bg-[#2a2d35] dark:enabled:hover:text-[#f4f4f5]"
                      type="button"
                      title="下移一条，更晚执行"
                      :disabled="commandIndex === workspace.commands.length - 1"
                      @click="moveCommand(workspace.id, commandIndex, 1)"
                    >
                      ↓
                    </button>
                  </span>
                  <input
                    class="min-w-0 rounded-[6px] border border-[#dfe2e8] bg-[#fbfbfd] px-2 py-1 text-[12px] text-[#202229] outline-none transition-colors duration-200 focus:border-[#ff5c5c] dark:border-[#3a3d46] dark:bg-[#1c1e24] dark:text-[#f4f4f5]"
                    placeholder="例如 docker start mysql"
                    type="text"
                    :value="command"
                    @blur="saveCommand(workspace.id, commandIndex, $event)"
                    @keydown.enter="($event.target as HTMLInputElement).blur()"
                  />
                  <button
                    class="grid size-7 place-items-center rounded-[6px] text-[#8b909b] transition-colors duration-200 hover:bg-[#ffe3e3] hover:text-[#c33] dark:text-[#7d828c] dark:hover:bg-[#3a2226] dark:hover:text-[#ff8f8f]"
                    type="button"
                    title="删除该命令"
                    @click="removeCommand(workspace.id, commandIndex)"
                  >
                    <XCircle :size="13" />
                  </button>
                </div>
              </div>

              <div class="mt-2 flex items-center gap-2">
                <input
                  class="min-w-0 flex-1 rounded-[6px] border border-[#dfe2e8] bg-[#fbfbfd] px-2 py-1 text-[12px] text-[#202229] outline-none transition-colors duration-200 focus:border-[#ff5c5c] dark:border-[#3a3d46] dark:bg-[#1c1e24] dark:text-[#f4f4f5]"
                  placeholder="输入命令后回车添加，例如 docker start mysql"
                  type="text"
                  :value="newCommandDraft"
                  @input="
                    newCommandDraft = ($event.target as HTMLInputElement).value
                  "
                  @keydown.enter="addCommand(workspace.id)"
                />
                <button
                  class="shrink-0 rounded-[6px] bg-[#eef0f4] px-2.5 py-1 text-[12px] font-medium text-[#5c626e] transition-colors duration-200 hover:bg-[#e3e5eb] disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[#23262d] dark:text-[#a7abb5] dark:hover:bg-[#2a2d35]"
                  type="button"
                  :disabled="newCommandDraft.trim().length === 0"
                  @click="addCommand(workspace.id)"
                >
                  添加
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
          <h2
            class="text-[14px] font-semibold text-[#202229] dark:text-[#f4f4f5]"
          >
            正在启动 {{ restoreDialog.workspaceName }}
          </h2>
          <p class="mt-1 text-[12px] text-[#707684] dark:text-[#9ca0aa]">
            {{
              restoreFinished
                ? restoreSummary
                : "Dasktop 正在逐个启动应用并移动到保存位置"
            }}
          </p>
        </div>

        <div class="dasktop-scrollarea max-h-[300px] overflow-y-auto px-5 py-3">
          <div
            v-for="item in restoreDialog.items"
            :key="item.key"
            class="flex items-start gap-2.5 py-2"
          >
            <img
              v-if="restoreDialogIcons[item.key]"
              class="mt-0.5 size-4 shrink-0 rounded-[3px] object-contain"
              :src="restoreDialogIcons[item.key]"
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
              <AlertCircle
                v-else
                :size="14"
                class="text-[#c33] dark:text-[#ff8f8f]"
              />
            </span>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5">
                <span
                  class="truncate text-[12px] font-medium text-[#202229] dark:text-[#f4f4f5]"
                >
                  {{ item.label }}
                </span>
                <!-- 有图标时状态指示器移到名称右侧，避免与图标抢占同一位置 -->
                <span v-if="restoreDialogIcons[item.key]" class="shrink-0">
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
                  <AlertCircle
                    v-else
                    :size="13"
                    class="text-[#c33] dark:text-[#ff8f8f]"
                  />
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

        <div
          class="flex justify-end border-t border-[#e7e9ee] px-5 py-3 dark:border-[#292c34]"
        >
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
