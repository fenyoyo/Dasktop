import { ref } from "vue";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { useWorkspaceStore } from "@/entities/workspace/store";
import type { WorkspaceRestoreResult } from "@/entities/workspace/types";
import { listenStartupWorkspaceRequested } from "@/shared/ipc/workspace";

/**
 * 工作区快捷方式启动的跨面板编排。
 *
 * 工作区还原此前挂在 `WorkspacePanel` 的 `onMounted` 上，而该面板由
 * `v-else-if` 按当前页签条件渲染——冷启动时设置窗默认停在 Box 页签，
 * 面板从未挂载，快捷方式因此看起来「点了没反应」。
 *
 * 这里把启动编排上移到设置页根组件，使还原不再依赖用户手动切换页签：
 * - 冷启动：读取进程 `argv` 中的 `--workspace`，命中则直接还原；
 * - 热启动（主实例已运行）：后端通过命名管道转交参数并广播事件，这里监听。
 *
 * 同时对外暴露 `requestedWorkspaceId`，供根组件在启动命中时切到工作区页签，
 * 让用户直接看到还原进度。
 */
export function useWorkspaceStartup() {
  const workspaceStore = useWorkspaceStore();

  /**
   * 本次启动需要展示的工作区 ID；为空表示非快捷方式启动。
   */
  const requestedWorkspaceId = ref("");

  /**
   * 启动还原结果，交给工作区面板展示状态提示。
   */
  const startupResults = ref<WorkspaceRestoreResult[]>([]);

  /**
   * 启动阶段错误，只提示不阻断设置页正常加载。
   */
  const startupError = ref("");

  const unlistenFns: UnlistenFn[] = [];

  /**
   * 注册二次启动监听并处理本次进程自带的启动参数。
   *
   * 返回本次冷启动命中的工作区 ID（无则空串），调用方据此决定是否切换页签。
   */
  async function initializeWorkspaceStartup(): Promise<string> {
    // 先注册监听再读启动参数：主实例场景下事件可能早于本函数返回，
    // 顺序颠倒会丢掉「窗口已显示但参数刚送达」的那一次广播。
    unlistenFns.push(
      await listenStartupWorkspaceRequested(async ({ payload }) => {
        requestedWorkspaceId.value = payload;
        await runRestore(payload);
      }),
    );

    const startupWorkspaceId = await workspaceStore.resolveStartupWorkspace();
    if (!startupWorkspaceId) {
      return "";
    }

    requestedWorkspaceId.value = startupWorkspaceId;
    await runRestore(startupWorkspaceId);

    return startupWorkspaceId;
  }

  /**
   * 执行一次工作区还原，失败只记录错误不抛出。
   */
  async function runRestore(workspaceId: string): Promise<void> {
    startupError.value = "";

    try {
      await workspaceStore.initializeWorkspaces();
      const results = await workspaceStore.launchWorkspace(workspaceId);
      startupResults.value = results;
    } catch (error) {
      startupError.value = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * 设置页卸载时注销监听，避免热更新后重复触发。
   */
  function disposeWorkspaceStartup(): void {
    for (const unlisten of unlistenFns) {
      unlisten();
    }
    unlistenFns.splice(0);
  }

  return {
    disposeWorkspaceStartup,
    initializeWorkspaceStartup,
    requestedWorkspaceId,
    startupError,
    startupResults,
  };
}
