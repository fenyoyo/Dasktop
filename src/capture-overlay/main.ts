/*
 * 屏幕框选层的交互逻辑。
 *
 * 这一层由宿主在弹出框选窗口时加载，页面本身只做三件事：让用户拖出一个矩形、
 * 把选区（CSS 像素）交给宿主、把用户的取消意图也交给宿主。截图与坐标换算都在
 * Rust 侧完成——页面拿不到屏幕像素，也不需要知道目标显示器在哪。
 *
 * 交互规则刻意贴近常见的截图工具：左键拖拽出选区并实时显示尺寸，松开即提交；
 * Esc 或右键取消；过小的选区（本质是误触）不提交而是允许重来。
 */

import { invoke } from "@tauri-apps/api/core";

import "./style.css";

/**
 * 允许提交的最小选区边长（CSS 像素）。
 *
 * 与 Rust 侧 `services/plugin/screen_capture.rs` 的 `MIN_SELECTION_EDGE` 同口径：
 * 点一下就松手会产生 0×0 的选区，提交上去只会换来一条「框选范围过小」的错误，
 * 因此这里先挡住，让误触表现为「没选中」而不是一次失败调用。
 */
const MIN_SELECTION_EDGE = 2;

const selectionBox = document.getElementById("selection") as HTMLElement;
const sizeTag = document.getElementById("size-tag") as HTMLElement;
const hint = document.getElementById("hint") as HTMLElement;

/** 拖拽起点，单位为相对视口的 CSS 像素。 */
let startX = 0;
let startY = 0;

/** 是否正在拖拽。 */
let dragging = false;

/**
 * 是否已经提交或取消。
 *
 * 置位后忽略一切后续输入：命令返回时覆盖窗口才开始关闭，这中间用户还可能继续点击，
 * 放任下去会发出第二次提交，而那时宿主侧会话已经被取走，只会得到一条无意义的报错。
 */
let settled = false;

/**
 * 按当前选区重绘边框与尺寸提示。
 */
function renderSelection(x: number, y: number, width: number, height: number): void {
  selectionBox.hidden = false;
  selectionBox.style.left = `${x}px`;
  selectionBox.style.top = `${y}px`;
  selectionBox.style.width = `${width}px`;
  selectionBox.style.height = `${height}px`;
  sizeTag.textContent = `${Math.round(width)} × ${Math.round(height)}`;
}

/**
 * 把起点与当前光标位置规整成左上角原点的矩形。
 *
 * 用户可以从右下往左上拖，直接使用 clientX 差值会得到负宽高，选区边框会反向绘制。
 */
function normalizeSelection(currentX: number, currentY: number) {
  return {
    x: Math.min(startX, currentX),
    y: Math.min(startY, currentY),
    width: Math.abs(currentX - startX),
    height: Math.abs(currentY - startY),
  };
}

/**
 * 提交选区，交给宿主去截图。
 */
function submitSelection(x: number, y: number, width: number, height: number): void {
  settled = true;

  void invoke("finish_plugin_screen_capture", {
    selection: { x, y, width, height },
  }).catch((error) => {
    console.error("[capture-overlay] 提交框选结果失败", error);
  });
}

/**
 * 取消本次框选。
 */
function cancelSelection(): void {
  if (settled) {
    return;
  }

  settled = true;

  void invoke("cancel_plugin_screen_capture").catch((error) => {
    console.error("[capture-overlay] 取消框选失败", error);
  });
}

/**
 * 复位选区，让用户可以重新拖一次。
 */
function resetSelection(): void {
  selectionBox.hidden = true;
  hint.hidden = false;
}

window.addEventListener("mousedown", (event) => {
  // 只响应左键：右键在本层承担「取消」，中键不参与框选。
  if (settled || event.button !== 0) {
    return;
  }

  dragging = true;
  startX = event.clientX;
  startY = event.clientY;

  hint.hidden = true;
  renderSelection(startX, startY, 0, 0);
});

window.addEventListener("mousemove", (event) => {
  if (!dragging || settled) {
    return;
  }

  const selection = normalizeSelection(event.clientX, event.clientY);
  renderSelection(selection.x, selection.y, selection.width, selection.height);
});

window.addEventListener("mouseup", (event) => {
  if (!dragging || settled || event.button !== 0) {
    return;
  }

  dragging = false;

  const selection = normalizeSelection(event.clientX, event.clientY);
  if (selection.width < MIN_SELECTION_EDGE || selection.height < MIN_SELECTION_EDGE) {
    resetSelection();
    return;
  }

  renderSelection(selection.x, selection.y, selection.width, selection.height);
  submitSelection(selection.x, selection.y, selection.width, selection.height);
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    cancelSelection();
  }
});

window.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  cancelSelection();
});
