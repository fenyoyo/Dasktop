import { ref } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  createDesktopStartupSnapshotServer,
  listenBoxWindowReady,
} from "@/shared/ipc/desktop";
import { listenAutostartChanged, listenTrayCreateBox } from "@/shared/ipc/appTray";
import { isAutostartLaunch } from "@/entities/appSettings/api";
import { openBoxWindow, showBoxWindow } from "@/entities/desktopBox/windows";
import type { useDesktopStore } from "@/entities/desktopBox/store";

const BOX_STARTUP_READY_WAIT_MS = 8_000;

/**
 * 设置页启动组合式逻辑负责初始化 Store、监听托盘入口并批量恢复 Box 窗口。
 *
 * `shouldKeepVisibleAfterBoxRestore` 由调用方传入，用于叠加启动意图：
 * 由工作区快捷方式启动时必须保持可见，否则用户看不到还原进度；
 * 其余情况再按「本次是否开机自启」决定——自启静默驻留托盘，用户手动启动则保留界面。
 */
export function useSettingsStartup(
  desktopStore: ReturnType<typeof useDesktopStore>,
  syncAutostartEnabled: () => Promise<void>,
  createAndOpenBox: () => Promise<void>,
  setAutostartEnabledFromEvent: (enabled: boolean) => void,
  shouldKeepVisibleAfterBoxRestore: () => boolean = () => false,
) {
  const currentWindow = getCurrentWindow();
  const startupError = ref("");
  const unlistenFns: UnlistenFn[] = [];

  /**
   * 设置页启动时完成 Store 初始化和托盘事件绑定；Box 全部恢复后隐藏主设置窗。
   */
  async function initializeSettingsStartup(): Promise<void> {
    await desktopStore.initialize();
    await syncAutostartEnabled();
    unlistenFns.push(
      await listenAutostartChanged(({ payload }) => {
        setAutostartEnabledFromEvent(payload);
      }),
    );
    unlistenFns.push(
      await listenTrayCreateBox(async () => {
        await createAndOpenBox();
      }),
    );

    // Box 恢复完成后按启动意图决定是否收起设置窗。
    //
    // 顺序很重要：先看「本次是否自启」——自启是唯一需要静默的场景；
    // 再由调用方叠加工作区快捷方式例外，否则用户看不到还原进度。
    if (await openAllBoxes()) {
      const isSilentAutostartLaunch = await resolveSilentAutostartLaunch();
      if (isSilentAutostartLaunch && !shouldKeepVisibleAfterBoxRestore()) {
        await currentWindow.hide();
      }
    }
  }

  /**
   * 读取本次是否由开机自启拉起。
   *
   * 查询失败时按「非自启」兜底：宁可多显示一次设置窗，也不要让用户手动启动后
   * 界面被静默收起而以为程序没运行。
   */
  async function resolveSilentAutostartLaunch(): Promise<boolean> {
    try {
      return await isAutostartLaunch();
    } catch (error) {
      console.warn("failed to resolve autostart launch intent", error);
      return false;
    }
  }

  /**
   * 设置页启动时批量打开现有 Box，避免窗口数量多时串行等待拖慢桌面恢复。
   */
  async function openAllBoxes(): Promise<boolean> {
    startupError.value = "";
    const startupBoxes = [...desktopStore.boxes];
    if (startupBoxes.length === 0) {
      return true;
    }

    try {
      const [readyTracker, startupSnapshotServer] = await Promise.all([
        createBoxWindowReadyTracker(),
        createDesktopStartupSnapshotServer(desktopStore.createStartupSnapshot()),
      ]);

      try {
        const openResults = await Promise.allSettled(
          startupBoxes.map((box) =>
            openBoxWindow(box, {
              focus: false,
              startupSnapshotToken: startupSnapshotServer.token,
              /**
               * WebView 文件区首帧依赖窗口完成布局，启动恢复先显示再等待 ready 可减少空白闪烁。
               */
              visible: true,
            }),
          ),
        );
        const openedBoxes = startupBoxes.filter(
          (_, index) => openResults[index]?.status === "fulfilled",
        );
        const failedOpenResults = openResults.filter(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        await readyTracker.waitFor(
          openedBoxes.map((box) => box.id),
          BOX_STARTUP_READY_WAIT_MS,
        );
        const showResults = await Promise.allSettled(
          openedBoxes.map((box) => showBoxWindow(box, { focus: false })),
        );
        const failedShowResults = showResults.filter(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        const failedResults = [...failedOpenResults, ...failedShowResults];

        if (failedResults.length === 0) {
          return true;
        }

        startupError.value = formatBatchOpenBoxError(failedResults);
        return false;
      } finally {
        readyTracker.dispose();
        startupSnapshotServer.dispose();
      }
    } catch (error) {
      startupError.value = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  /**
   * 启动恢复时先监听 ready，再创建隐藏 Box，避免 ready 事件早于监听注册导致统一显示卡住。
   */
  async function createBoxWindowReadyTracker(): Promise<{
    dispose: () => void;
    waitFor: (boxIds: string[], timeoutMs: number) => Promise<boolean>;
  }> {
    const readyBoxIds = new Set<string>();
    const waiters: Array<() => void> = [];
    const unlisten = await listenBoxWindowReady(({ payload }) => {
      readyBoxIds.add(payload.boxId);
      for (const waiter of [...waiters]) {
        waiter();
      }
    });

    return {
      dispose: () => {
        unlisten();
        waiters.splice(0);
      },
      waitFor: (boxIds, timeoutMs) =>
        waitForReadyBoxIds(boxIds, timeoutMs, readyBoxIds, waiters),
    };
  }

  /**
   * 等待目标 Box 首帧准备完成；超时后继续展示窗口，防止异常窗口永久隐藏。
   */
  function waitForReadyBoxIds(
    boxIds: string[],
    timeoutMs: number,
    readyBoxIds: Set<string>,
    waiters: Array<() => void>,
  ): Promise<boolean> {
    const targetBoxIds = Array.from(new Set(boxIds));
    if (areAllBoxesReady(targetBoxIds, readyBoxIds)) {
      return Promise.resolve(true);
    }

    return new Promise<boolean>((resolve) => {
      let isSettled = false;
      const settle = (isReady: boolean): void => {
        if (isSettled) {
          return;
        }

        isSettled = true;
        window.clearTimeout(timeoutTimer);
        const waiterIndex = waiters.indexOf(waiter);
        if (waiterIndex >= 0) {
          waiters.splice(waiterIndex, 1);
        }
        resolve(isReady);
      };
      const waiter = (): void => {
        if (areAllBoxesReady(targetBoxIds, readyBoxIds)) {
          settle(true);
        }
      };
      const timeoutTimer = window.setTimeout(() => settle(false), timeoutMs);

      waiters.push(waiter);
      waiter();
    });
  }

  /**
   * 空列表视为已准备，方便没有成功打开窗口时直接进入错误处理分支。
   */
  function areAllBoxesReady(boxIds: string[], readyBoxIds: Set<string>): boolean {
    return boxIds.every((boxId) => readyBoxIds.has(boxId));
  }

  /**
   * 批量打开失败时保留第一条真实错误，并提示失败数量，避免大量窗口错误淹没设置页。
   */
  function formatBatchOpenBoxError(failedResults: PromiseRejectedResult[]): string {
    const [firstFailure] = failedResults;
    const firstMessage =
      firstFailure.reason instanceof Error
        ? firstFailure.reason.message
        : String(firstFailure.reason);

    return `${failedResults.length} 个 Box 启动失败：${firstMessage}`;
  }

  /**
   * 设置页卸载时注销跨窗口监听，避免热更新后托盘事件重复触发。
   */
  function disposeSettingsStartup(): void {
    for (const unlisten of unlistenFns) {
      unlisten();
    }
    unlistenFns.splice(0);
  }

  return {
    disposeSettingsStartup,
    initializeSettingsStartup,
    startupError,
  };
}
