import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  LogicalPosition,
  LogicalSize,
  PhysicalPosition,
  PhysicalSize,
  currentMonitor,
  getCurrentWindow,
  primaryMonitor,
} from "@tauri-apps/api/window";
import type { DesktopBox } from "@/entities/desktopBox/types";
import { glueBoxWindowToDesktop } from "@/entities/desktopBox/api";
import { BOX_CONTEXT_MENU_LAYOUT, BOX_WINDOW_SIZE } from "@/entities/desktopBox/layout";
import {
  clearBoxContextMenuReady,
  type BoxContextMenuPreparedPayload,
  isBoxContextMenuReady,
  listenBoxContextMenuPrepared,
  listenBoxContextMenuReady,
  requestBoxContextMenuClose,
  requestBoxContextMenuOpen,
} from "@/shared/ipc/boxContextMenu";

/**
 * 系统窗口标题需要保留可识别文本；Box 自身标题仍允许用户保存为空
 */
const UNTITLED_BOX_WINDOW_TITLE = "Dasktop Box";

/**
 * 打开 Box 的策略参数，启动恢复时不抢焦点，用户主动打开时再切到前台
 */
export interface OpenBoxWindowOptions {
  focus?: boolean;
  /**
   * 批量启动时由主窗口传入共享快照 token，Box 窗口可直接 hydrate Store
   */
  startupSnapshotToken?: string;
  /**
   * 启动批量恢复时先隐藏创建，等待所有 Box 首帧准备好后再统一展示
   */
  visible?: boolean;
}

/**
 * 更多菜单的窗口定位使用物理屏幕坐标，避免高 DPI 下 WebView 坐标与原生窗口坐标混用
 */
export interface BoxContextMenuTriggerPosition {
  x: number;
  y: number;
}

/**
 * 菜单窗口打开前按当前显示器工作区计算物理坐标和高度，保证小分辨率下不会超出屏幕。
 */
interface BoxContextMenuResolvedPlacement {
  height: number;
  position: BoxContextMenuTriggerPosition;
  width: number;
}

/**
 * 菜单按钮采用切换语义，调用方可据此恢复折叠 Box 的临时展开状态
 */
export type BoxContextMenuToggleResult = "closed" | "opened";

/**
 * Box 窗口标签统一加前缀，便于 capability 使用 `box_*` 授权动态窗口
 */
export function boxWindowLabel(boxId: string): string {
  return `box_${boxId.replace(/-/g, "_")}`;
}

/**
 * Box 更多菜单改为单例预载窗口，点击时只移动、展示并切换激活 Box，降低首次之外的打开延迟
 */
const BOX_CONTEXT_MENU_WINDOW_LABEL = "box_menu";

let preloadBoxContextMenuWindowPromise: Promise<WebviewWindow> | null = null;

/**
 * 预载窗口隐藏创建时只需要一个合法初始高度；真实展示高度由菜单内容测量结果决定。
 */
const BOX_CONTEXT_MENU_INITIAL_HEIGHT = 1;

/**
 * ready 只兜底等待首轮预载；超时后仍允许 show，避免异常 ready 事件导致点击永久无响应
 */
const BOX_CONTEXT_MENU_READY_WAIT_MS = 1200;

/**
 * 每个 Box 都创建独立 WebView 窗口，桌面空白区域不被全屏透明层截获
 */
export async function openBoxWindow(
  box: DesktopBox,
  options: OpenBoxWindowOptions = {},
): Promise<void> {
  const label = boxWindowLabel(box.id);
  const existingWindow = await WebviewWindow.getByLabel(label);
  const shouldFocus = options.focus ?? true;
  const shouldShowInitially = options.visible ?? true;

  if (existingWindow) {
    await existingWindow.setPosition(new LogicalPosition(box.x, box.y));
    await existingWindow.setSize(new LogicalSize(box.width, box.height));
    await existingWindow.setResizable(!box.locked && !box.collapsed);
    // 已存在的窗口也补一次固定：幂等操作
    void glueBoxWindowToDesktopSafely(label);
    if (shouldShowInitially) {
      await existingWindow.show();
    }
    if (shouldShowInitially && shouldFocus) {
      await existingWindow.setFocus();
    }
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const window = new WebviewWindow(label, {
      url: resolveBoxWindowUrl(box.id, options.startupSnapshotToken),
      title: box.title || UNTITLED_BOX_WINDOW_TITLE,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      minWidth: BOX_WINDOW_SIZE.min.width,
      minHeight: BOX_WINDOW_SIZE.min.height,
      decorations: false,
      dragDropEnabled: true,
      focus: shouldFocus,
      transparent: true,
      shadow: false,
      resizable: !box.locked && !box.collapsed,
      skipTaskbar: true,
      preventOverflow: true,
      visible: shouldShowInitially,
    });

    void window.once("tauri://created", async () => {
      if (shouldShowInitially && !shouldFocus) {
        await window.show();
      }
      // 挂载后立即固定为「置顶 + 免疫 Win+D」；固定后台执行，失败只降级为普通顶层窗口，不阻断打开流程
      void glueBoxWindowToDesktopSafely(label);
      resolve();
    });
    void window.once<unknown>("tauri://error", (error) => reject(error.payload));
  });
}

/**
 * 桌面置顶固定的兜底包装：失败只记录警告，避免吞掉 Box 打开主流程
 */
function glueBoxWindowToDesktopSafely(label: string): Promise<void> {
  return glueBoxWindowToDesktop(label).catch((error) => {
    console.warn(`[desktopBox] 窗口 ${label} 桌面固定失败，保持普通顶层窗口`, error);
  });
}

/**
 * 批量启动恢复结束后统一显示 Box，减少窗口逐个创建时的视觉跳动
 */
export async function showBoxWindow(
  box: DesktopBox,
  options: Pick<OpenBoxWindowOptions, "focus"> = {},
): Promise<void> {
  const existingWindow = await WebviewWindow.getByLabel(boxWindowLabel(box.id));
  if (!existingWindow) {
    return;
  }

  await existingWindow.show();
  if (options.focus ?? false) {
    await existingWindow.setFocus();
  }
}

/**
 * Box URL 只携带轻量 token，真实启动数据放在跨 WebView storage，避免 URL 过长
 */
function resolveBoxWindowUrl(boxId: string, startupSnapshotToken?: string): string {
  const searchParams = new URLSearchParams({
    boxId,
  });

  if (startupSnapshotToken) {
    searchParams.set("startupSnapshot", startupSnapshotToken);
  }

  return `/?${searchParams.toString()}`;
}

/**
 * 关闭指定 Box 的内容窗口，删除 Box 时由菜单窗口调用以避免留下空白 WebView
 */
export async function closeBoxWindow(boxId: string): Promise<void> {
  const existingWindow = await WebviewWindow.getByLabel(boxWindowLabel(boxId));
  await existingWindow?.close();
}

/**
 * 预载独立菜单窗口，隐藏窗口提前完成 Vue 初始化，避免用户点击更多按钮时等待 WebView 创建
 */
export async function preloadBoxContextMenuWindow(): Promise<WebviewWindow> {
  const existingWindow = await WebviewWindow.getByLabel(BOX_CONTEXT_MENU_WINDOW_LABEL);
  if (existingWindow) {
    return existingWindow;
  }

  if (!preloadBoxContextMenuWindowPromise) {
    preloadBoxContextMenuWindowPromise = createBoxContextMenuWindow().catch(async (error) => {
      preloadBoxContextMenuWindowPromise = null;
      const createdByOtherWindow = await WebviewWindow.getByLabel(BOX_CONTEXT_MENU_WINDOW_LABEL);
      if (createdByOtherWindow) {
        return createdByOtherWindow;
      }

      throw error;
    });
  }

  return preloadBoxContextMenuWindowPromise;
}

/**
 * 打开独立的 Box 更多菜单；窗口已预载时只执行定位、显示和激活事件
 */
export async function openBoxContextMenuWindow(
  boxId: string,
  triggerPosition: BoxContextMenuTriggerPosition,
): Promise<void> {
  const requestId = crypto.randomUUID();
  const menuWindow = await preloadBoxContextMenuWindow();

  await waitForBoxContextMenuReady();
  const preparedPayload = await requestPreparedBoxContextMenuOpen(boxId, requestId);
  const menuPlacement = await resolveBoxContextMenuPlacement(
    triggerPosition,
    preparedPayload.height,
  );
  await Promise.all([
    menuWindow.setSize(new PhysicalSize(menuPlacement.width, menuPlacement.height)),
    menuWindow.setPosition(
      new PhysicalPosition(menuPlacement.position.x, menuPlacement.position.y),
    ),
    menuWindow.setAlwaysOnTop(true),
  ]);
  await menuWindow.show();
  await requestBoxContextMenuOpen(boxId, requestId, "visible");
  void menuWindow.setFocus();
}

/**
 * 外部交互需要关闭菜单时走动画事件，避免 helper 侧定时 hide 误伤快速重新打开的菜单
 */
export async function closeBoxContextMenuWindow(boxId?: string): Promise<void> {
  const existingWindow = await WebviewWindow.getByLabel(BOX_CONTEXT_MENU_WINDOW_LABEL);
  if (!existingWindow) {
    return;
  }

  await requestCloseBoxContextMenuWindow(boxId);
}

/**
 * 兼容更多按钮切换语义；调用方负责根据状态事件判断是否需要关闭，打开路径不再猜测窗口存在性
 */
export async function toggleBoxContextMenuWindow(
  boxId: string,
  triggerPosition: BoxContextMenuTriggerPosition,
  isOpen: boolean,
): Promise<BoxContextMenuToggleResult> {
  if (isOpen) {
    await closeBoxContextMenuWindow(boxId);
    return "closed";
  }

  await openBoxContextMenuWindow(boxId, triggerPosition);
  return "opened";
}

/**
 * 菜单使用独立透明窗口承载，解决 WebView 原生边界裁剪，同时不改变 Box 自身尺寸
 */
async function createBoxContextMenuWindow(): Promise<WebviewWindow> {
  clearBoxContextMenuReady();

  const menuWindow = await new Promise<WebviewWindow>((resolve, reject) => {
    const createdWindow = new WebviewWindow(BOX_CONTEXT_MENU_WINDOW_LABEL, {
      alwaysOnTop: true,
      decorations: false,
      dragDropEnabled: false,
      focus: false,
      height: BOX_CONTEXT_MENU_INITIAL_HEIGHT,
      resizable: false,
      shadow: false,
      skipTaskbar: true,
      title: "Dasktop Box Menu",
      transparent: true,
      url: "/?boxMenu=1",
      visible: false,
      width: BOX_CONTEXT_MENU_LAYOUT.width,
      x: 0,
      y: 0,
    });

    void createdWindow.once("tauri://created", async () => {
      await createdWindow.setAlwaysOnTop(true);
      resolve(createdWindow);
    });
    void createdWindow.once<unknown>("tauri://error", (error) => reject(error.payload));
  });

  void waitForBoxContextMenuReady().catch(() => undefined);
  return menuWindow;
}

/**
 * 打开事件发送前确认菜单 Vue 侧监听已注册；隐藏 WebView 未初始化时，show 后仍会等待这一关
 */
async function waitForBoxContextMenuReady(): Promise<void> {
  if (isBoxContextMenuReady()) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let unlistenReady: (() => void) | null = null;
    let isSettled = false;
    const settleReady = (): void => {
      if (isSettled) {
        return;
      }

      isSettled = true;
      window.clearTimeout(readyFallbackTimer);
      unlistenReady?.();
      resolve();
    };
    const readyFallbackTimer = window.setTimeout(() => {
      settleReady();
    }, BOX_CONTEXT_MENU_READY_WAIT_MS);

    listenBoxContextMenuReady(() => {
      settleReady();
    })
      .then((unlisten) => {
        if (isSettled) {
          unlisten();
          return;
        }

        unlistenReady = unlisten;
      })
      .catch((error) => {
        if (isSettled) {
          return;
        }

        isSettled = true;
        window.clearTimeout(readyFallbackTimer);
        reject(error);
      });
  });
}

/**
 * 菜单窗口先在隐藏状态写好透明首帧，监听必须先于请求注册，避免 prepared 回执丢失造成慢半拍
 */
async function requestPreparedBoxContextMenuOpen(
  boxId: string,
  requestId: string,
): Promise<BoxContextMenuPreparedPayload> {
  let unlistenPrepared: (() => void) | null = null;
  let preparedFallbackTimer: ReturnType<typeof window.setTimeout> | null = null;
  let settlePrepared: (payload?: BoxContextMenuPreparedPayload) => void = () => undefined;
  const waitPrepared = new Promise<BoxContextMenuPreparedPayload>((resolve) => {
    let isSettled = false;

    settlePrepared = (payload?: BoxContextMenuPreparedPayload): void => {
      if (isSettled) {
        return;
      }

      isSettled = true;
      if (preparedFallbackTimer) {
        window.clearTimeout(preparedFallbackTimer);
        preparedFallbackTimer = null;
      }
      unlistenPrepared?.();
      unlistenPrepared = null;
      resolve(payload ?? { height: BOX_CONTEXT_MENU_INITIAL_HEIGHT, requestId });
    };
  });

  const requestHiddenOpen = async (): Promise<void> => {
    await requestBoxContextMenuOpen(boxId, requestId, "hidden");
  };

  try {
    unlistenPrepared = await listenBoxContextMenuPrepared(({ payload }) => {
      if (payload.requestId === requestId) {
        settlePrepared(payload);
      }
    });
    preparedFallbackTimer = window.setTimeout(() => {
      settlePrepared();
    }, BOX_CONTEXT_MENU_LAYOUT.preparedWaitMs);
    await requestHiddenOpen();
    return await waitPrepared;
  } catch {
    await requestHiddenOpen().catch(() => undefined);
    settlePrepared();
    return await waitPrepared;
  }
}

/**
 * 关闭请求交给菜单窗口播放退出动画并自行 hide，避免跨 Box 快速切换时旧定时器覆盖新状态
 */
async function requestCloseBoxContextMenuWindow(boxId: string | undefined): Promise<void> {
  await requestBoxContextMenuClose(boxId);
}

/**
 * 菜单默认从按钮右下方弹出，若靠近屏幕边缘则翻转到上方，并在当前显示器工作区内压缩高度。
 */
async function resolveBoxContextMenuPlacement(
  triggerPosition: BoxContextMenuTriggerPosition,
  preferredLogicalHeight: number,
): Promise<BoxContextMenuResolvedPlacement> {
  const scaleFactor = await getCurrentWindow().scaleFactor();
  const monitor = (await currentMonitor()) ?? (await primaryMonitor());
  const menuWidth = BOX_CONTEXT_MENU_LAYOUT.width * scaleFactor;
  const triggerGap = BOX_CONTEXT_MENU_LAYOUT.triggerGap * scaleFactor;
  const viewportPadding = BOX_CONTEXT_MENU_LAYOUT.viewportPadding * scaleFactor;
  const workAreaX = monitor?.workArea.position.x ?? monitor?.position.x ?? 0;
  const workAreaY = monitor?.workArea.position.y ?? monitor?.position.y ?? 0;
  const workAreaWidth =
    monitor?.workArea.size.width ?? monitor?.size.width ?? menuWidth + triggerPosition.x;
  const workAreaHeight =
    monitor?.workArea.size.height ??
    monitor?.size.height ??
    Math.max(1, preferredLogicalHeight) * scaleFactor + triggerPosition.y;
  const minX = workAreaX + viewportPadding;
  const minY = workAreaY + viewportPadding;
  const maxX = workAreaX + workAreaWidth - menuWidth - viewportPadding;
  const maxAvailableMenuHeight = Math.max(
    scaleFactor,
    workAreaHeight - viewportPadding * 2,
  );
  const menuHeight = Math.min(
    Math.max(1, preferredLogicalHeight) * scaleFactor,
    maxAvailableMenuHeight,
  );
  const maxY = workAreaY + workAreaHeight - menuHeight - viewportPadding;
  const preferredX = triggerPosition.x - menuWidth + triggerGap * 2;
  const preferredBelowY = triggerPosition.y + triggerGap;
  const preferredAboveY = triggerPosition.y - menuHeight - triggerGap;
  const preferredY = preferredBelowY <= maxY ? preferredBelowY : preferredAboveY;

  return {
    height: toNativeWindowCoordinate(menuHeight),
    position: {
      x: toNativeWindowCoordinate(clampMenuPosition(preferredX, minX, maxX)),
      y: toNativeWindowCoordinate(clampMenuPosition(preferredY, minY, maxY)),
    },
    width: toNativeWindowCoordinate(menuWidth),
  };
}

/**
 * 显示器尺寸极小时仍保证返回一个有效坐标，避免菜单定位得到 NaN 或反向范围
 */
function clampMenuPosition(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }

  return Math.min(Math.max(value, min), max);
}

/**
 * Tauri 的窗口定位命令在 Windows 侧接收 i32，DPI 换算后的 0.5 像素必须先规整
 */
function toNativeWindowCoordinate(value: number): number {
  return Math.round(value);
}

/**
 * 设置页由 main 窗口承载，唤起时先恢复最小化状态，确保 Box 菜单能把设置窗真正带回前台
 */
export async function openSettingsWindow(): Promise<void> {
  const existingMainWindow = await WebviewWindow.getByLabel("main");
  if (existingMainWindow) {
    await existingMainWindow.unminimize();
    await existingMainWindow.show();
    await existingMainWindow.setFocus();
    return;
  }
}
