import { ref } from "vue";
import { defineStore } from "pinia";
import {
  captureWorkspaceLayout,
  createWorkspaceDesktopShortcut,
  resolveCurrentExecutablePath,
  resolveExecutableIcons,
  resolveStartupWorkspaceId,
  restoreWorkspaceLayout,
} from "@/entities/workspace/api";
import {
  deleteWorkspaceRecord,
  loadWorkspaces,
  saveWorkspace,
} from "@/shared/storage/database";
import type { Workspace, WorkspaceRestoreResult, WorkspaceWindow } from "@/entities/workspace/types";

/**
 * 工作区状态管理。
 *
 * 捕获和还原都依赖系统级窗口操作，因此 Store 只负责把结果同步到界面，
 * 真正的窗口枚举、启动和定位全部在 Rust 侧完成。
 */
export const useWorkspaceStore = defineStore("workspace", () => {
  const workspaces = ref<Workspace[]>([]);
  const isBusy = ref(false);
  const lastRestoreResults = ref<WorkspaceRestoreResult[]>([]);

  /**
   * 应用图标缓存，键为可执行文件路径。
   *
   * 图标由 Shell 解析、开销明显高于普通查询，而同一个可执行文件的图标
   * 在运行期内不会变化，因此只在首次需要时解析并长期复用。
   */
  const executableIcons = ref<Record<string, string>>({});

  /**
   * 从数据库读取全部工作区，设置页初始化时调用。
   */
  async function initializeWorkspaces(): Promise<void> {
    workspaces.value = await loadWorkspaces();
    await ensureWorkspaceIcons();
  }

  /**
   * 确保当前所有工作区涉及的应用图标都已解析。
   *
   * 只请求缓存中缺失的路径，避免每次进出设置页都重复走一遍 Shell 解析。
   */
  async function ensureWorkspaceIcons(): Promise<void> {
    const pendingPaths = collectWorkspaceExecutablePaths().filter(
      (executablePath) => !(executablePath in executableIcons.value),
    );

    if (pendingPaths.length === 0) {
      return;
    }

    try {
      const resolved = await resolveExecutableIcons(pendingPaths);
      executableIcons.value = { ...executableIcons.value, ...resolved };
    } catch {
      // 图标属于展示增强，解析失败时静默降级到占位图标，
      // 不能因此打断工作区列表的正常渲染。
    }
  }

  /**
   * 汇总当前工作区中出现的全部可执行文件路径并去重。
   */
  function collectWorkspaceExecutablePaths(): string[] {
    const paths = new Set<string>();

    for (const workspace of workspaces.value) {
      for (const window of workspace.windows) {
        paths.add(window.executablePath);
      }
    }

    return [...paths];
  }

  /**
   * 捕获当前桌面布局并保存为新工作区。
   *
   * 捕获前先排除 Dasktop 自身进程，避免设置窗口被写进工作区后
   * 启动时反复拉起自己的设置界面。
   */
  async function captureAsWorkspace(name: string): Promise<Workspace> {
    isBusy.value = true;

    try {
      const currentExecutablePath = await resolveCurrentExecutablePath();
      const windows = await captureWorkspaceLayout([currentExecutablePath]);
      const workspace: Workspace = {
        createdAt: Date.now(),
        id: createWorkspaceId(),
        name,
        windows,
      };

      await saveWorkspace(workspace);
      workspaces.value = [...workspaces.value, workspace];
      await ensureWorkspaceIcons();

      return workspace;
    } finally {
      isBusy.value = false;
    }
  }

  /**
   * 启动工作区：拉起应用并把窗口还原到保存位置。
   */
  async function launchWorkspace(workspaceId: string): Promise<WorkspaceRestoreResult[]> {
    const workspace = workspaces.value.find((item) => item.id === workspaceId);
    if (!workspace) {
      throw new Error(`工作区不存在: ${workspaceId}`);
    }

    isBusy.value = true;

    try {
      const results = await restoreWorkspaceLayout(workspace.windows);
      lastRestoreResults.value = results;

      return results;
    } finally {
      isBusy.value = false;
    }
  }

  /**
   * 更新工作区名称，保持捕获时的窗口布局不变。
   */
  async function renameWorkspace(workspaceId: string, name: string): Promise<void> {
    const workspace = workspaces.value.find((item) => item.id === workspaceId);
    if (!workspace) {
      return;
    }

    const nextWorkspace: Workspace = { ...workspace, name };
    await saveWorkspace(nextWorkspace);
    workspaces.value = workspaces.value.map((item) =>
      item.id === workspaceId ? nextWorkspace : item,
    );
  }

  /**
   * 删除工作区，只清理数据库记录，不影响任何真实应用。
   */
  async function removeWorkspace(workspaceId: string): Promise<void> {
    await deleteWorkspaceRecord(workspaceId);
    workspaces.value = workspaces.value.filter((item) => item.id !== workspaceId);
  }

  /**
   * 用当前桌面布局覆盖已有工作区，保留原名称和创建时间。
   */
  async function recaptureWorkspace(workspaceId: string): Promise<WorkspaceWindow[]> {
    const workspace = workspaces.value.find((item) => item.id === workspaceId);
    if (!workspace) {
      throw new Error(`工作区不存在: ${workspaceId}`);
    }

    isBusy.value = true;

    try {
      const currentExecutablePath = await resolveCurrentExecutablePath();
      const windows = await captureWorkspaceLayout([currentExecutablePath]);
      const nextWorkspace: Workspace = { ...workspace, windows };
      await saveWorkspace(nextWorkspace);
      workspaces.value = workspaces.value.map((item) =>
        item.id === workspaceId ? nextWorkspace : item,
      );
      await ensureWorkspaceIcons();

      return windows;
    } finally {
      isBusy.value = false;
    }
  }

  /**
   * 更新单个应用的命令行参数。
   *
   * 参数按应用各自约定传入，用于控制多实例应用的启动行为，
   * 例如 VS Code 的 `--reuse-window` 可以复用已有窗口而不是新建。
   */
  async function updateWindowArguments(
    workspaceId: string,
    executablePath: string,
    argumentsValue: string,
  ): Promise<void> {
    const workspace = workspaces.value.find((item) => item.id === workspaceId);
    if (!workspace) {
      return;
    }

    const nextWorkspace: Workspace = {
      ...workspace,
      windows: workspace.windows.map((window) =>
        window.executablePath === executablePath
          ? { ...window, arguments: argumentsValue }
          : window,
      ),
    };

    await saveWorkspace(nextWorkspace);
    workspaces.value = workspaces.value.map((item) =>
      item.id === workspaceId ? nextWorkspace : item,
    );
  }

  /**
   * 设置单个应用还原后是否保持最小化。
   *
   * 直接接收目标状态而不是自行取反：调用方是复选框，勾选状态本身就是
   * 用户的意图，按值写入可以避免快速连点时读到过期的旧值。
   *
   * 与参数编辑一样只影响该应用的启动行为，不改变捕获到的坐标。
   */
  async function setWindowMinimized(
    workspaceId: string,
    executablePath: string,
    minimized: boolean,
  ): Promise<void> {
    const workspace = workspaces.value.find((item) => item.id === workspaceId);
    if (!workspace) {
      return;
    }

    const nextWorkspace: Workspace = {
      ...workspace,
      windows: workspace.windows.map((window) =>
        window.executablePath === executablePath ? { ...window, minimized } : window,
      ),
    };

    await saveWorkspace(nextWorkspace);
    workspaces.value = workspaces.value.map((item) =>
      item.id === workspaceId ? nextWorkspace : item,
    );
  }

  /**
   * 从工作区中移除单个应用，不影响真实进程。
   */
  async function removeWindow(workspaceId: string, executablePath: string): Promise<void> {
    const workspace = workspaces.value.find((item) => item.id === workspaceId);
    if (!workspace) {
      return;
    }

    const nextWorkspace: Workspace = {
      ...workspace,
      windows: workspace.windows.filter((window) => window.executablePath !== executablePath),
    };

    await saveWorkspace(nextWorkspace);
    workspaces.value = workspaces.value.map((item) =>
      item.id === workspaceId ? nextWorkspace : item,
    );
  }

  /**
   * 在桌面创建工作区快捷方式，返回快捷方式完整路径。
   */
  async function createDesktopShortcut(workspaceId: string, desktopPath: string): Promise<string> {
    const workspace = workspaces.value.find((item) => item.id === workspaceId);
    if (!workspace) {
      throw new Error(`工作区不存在: ${workspaceId}`);
    }

    return createWorkspaceDesktopShortcut(desktopPath, workspace.id, workspace.name);
  }

  /**
   * 读取本次启动是否来自工作区快捷方式。
   *
   * 覆盖两条来源：本进程 `argv` 直接携带参数（冷启动），
   * 以及主实例从单实例通道取回的待处理参数（热启动）。
   *
   * 返回 null 表示普通启动，调用方据此保持默认行为。
   */
  async function resolveStartupWorkspace(): Promise<string | null> {
    return resolveStartupWorkspaceId();
  }

  return {
    captureAsWorkspace,
    createDesktopShortcut,
    executableIcons,
    initializeWorkspaces,
    isBusy,
    lastRestoreResults,
    launchWorkspace,
    recaptureWorkspace,
    removeWindow,
    removeWorkspace,
    renameWorkspace,
    resolveStartupWorkspace,
    setWindowMinimized,
    updateWindowArguments,
    workspaces,
  };
});

/**
 * 生成工作区 ID，时间戳前缀保证列表按创建顺序可读。
 */
function createWorkspaceId(): string {
  return `ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
