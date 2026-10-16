/*
 * 截图工具逻辑。
 *
 * 流程：dasktop.screen.capture() 拿到选区 PNG base64 → 加载到画布 → 用户标注 →
 * 保存到文件（dasktop.file.save）或复制到剪贴板（dasktop.clipboard.writeImage）。
 *
 * 标注数据结构：shapes[] 保存已确认的图形，currentShape 保存正在绘制中的图形。
 * 每次绘制都把背景截图 + 全部图形重绘到画布，保证缩放与撤销一致。
 *
 * 宿主能力：screen:capture / fs:save / clipboard:write / ui:notify。
 */

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const placeholder = document.getElementById("placeholder");

const toolButtons = document.querySelectorAll(".tool");
const colorInput = document.getElementById("color");
const lineWidthSelect = document.getElementById("line-width");

const btnCapture = document.getElementById("btn-capture");
const btnUndo = document.getElementById("btn-undo");
const btnClear = document.getElementById("btn-clear");
const btnCopy = document.getElementById("btn-copy");
const btnSave = document.getElementById("btn-save");

const statusEl = document.getElementById("status");

let image = null;
let shapes = [];
let currentTool = "rect";
let color = "#ff3b30";
let lineWidth = 4;
let isDrawing = false;
let currentShape = null;

/* ------------------------------ 工具函数 ------------------------------ */

function setStatus(message, type = "muted") {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
}

function notify(title, message) {
  if (window.dasktop?.has?.("ui:notify")) {
    dasktop.notify(title, message).catch(() => {});
  }
}

/**
 * 把鼠标事件坐标换算成画布内部分辨率下的坐标。
 *
 * 画布内部分辨率等于截图原始尺寸，CSS 会把它缩放显示，因此需要按缩放比换算，
 * 否则标注会落在错误的位置，且保存时位置也会偏移。
 */
function toCanvasCoords(event) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;

  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY,
  };
}

/** 从 data URL 中取出 base64 载荷，与二维码插件的保存路径保持一致。 */
function dataUrlPayload(dataUrl) {
  const commaIndex = dataUrl.indexOf(",");

  return commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
}

/* ------------------------------ 绘制 ------------------------------ */

/**
 * 重绘画布：先画背景截图，再画已确认的标注，最后画正在绘制中的图形。
 *
 * 全量重绘而不是只画增量，是因为图形存在覆盖关系（后画的在上层），增量绘制在
 * 撤销/缩放时会留下残影；截图尺寸通常在几 MB 以内，重绘开销可接受。
 */
function draw() {
  if (!image) {
    return;
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

  for (const shape of shapes) {
    drawShape(shape);
  }

  if (currentShape) {
    drawShape(currentShape);
  }
}

function drawShape(shape) {
  ctx.strokeStyle = shape.color;
  ctx.fillStyle = shape.color;
  ctx.lineWidth = shape.lineWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  switch (shape.type) {
    case "rect":
      ctx.strokeRect(shape.x, shape.y, shape.w, shape.h);
      break;
    case "line":
      drawLine(shape.x1, shape.y1, shape.x2, shape.y2);
      break;
    case "arrow":
      drawLine(shape.x1, shape.y1, shape.x2, shape.y2);
      drawArrowHead(shape.x1, shape.y1, shape.x2, shape.y2);
      break;
    case "freehand":
      if (shape.points.length < 2) {
        break;
      }
      ctx.beginPath();
      ctx.moveTo(shape.points[0].x, shape.points[0].y);
      for (let i = 1; i < shape.points.length; i++) {
        ctx.lineTo(shape.points[i].x, shape.points[i].y);
      }
      ctx.stroke();
      break;
    case "text":
      ctx.font = `${shape.fontSize}px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif`;
      ctx.textBaseline = "top";
      ctx.fillText(shape.text, shape.x, shape.y);
      break;
  }
}

function drawLine(x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

/**
 * 在直线终点绘制箭头头部。
 *
 * 箭头由两条短线段组成，长度与张开角度随线宽缩放，保证细箭头不消失、粗箭头不过大。
 */
function drawArrowHead(x1, y1, x2, y2) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const headLength = Math.max(12, lineWidth * 3);
  const headAngle = Math.PI / 6;

  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(
    x2 - headLength * Math.cos(angle - headAngle),
    y2 - headLength * Math.sin(angle - headAngle),
  );
  ctx.moveTo(x2, y2);
  ctx.lineTo(
    x2 - headLength * Math.cos(angle + headAngle),
    y2 - headLength * Math.sin(angle + headAngle),
  );
  ctx.stroke();
}

/* ------------------------------ 截图采集 ------------------------------ */

/**
 * 发起屏幕截图。宿主弹出全屏框选层，用户拖拽选区后返回 PNG base64。
 *
 * 该调用会一直等待用户完成框选，因此期间状态栏给出提示，不锁死界面其它按钮
 * （虽然此时画布上没东西可标注）。用户按 Esc 取消时宿主返回 null，按主动放弃处理。
 */
async function captureScreen() {
  if (!window.dasktop?.has?.("screen:capture")) {
    setStatus("未获得屏幕截图权限", "error");
    return;
  }

  setStatus("请在屏幕上拖拽框选区域，按 Esc 取消", "muted");
  btnCapture.disabled = true;

  try {
    const base64 = await dasktop.screen.capture();

    if (!base64) {
      setStatus("已取消截图", "muted");
      return;
    }

    await loadImage(`data:image/png;base64,${base64}`);
    setStatus("截图完成，可在图上标注", "ok");
  } catch (error) {
    setStatus(`截图失败：${error.message || error}`, "error");
  } finally {
    btnCapture.disabled = false;
  }
}

/**
 * 加载截图到画布。
 *
 * 画布内部分辨率设为图片原始尺寸，保证标注与导出都是全分辨率；CSS 的 max-width/max-height
 * 负责把它缩放到容器内显示。加载成功后清空旧标注并启用操作按钮。
 */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      image = img;
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.hidden = false;
      shapes = [];
      currentShape = null;
      updateActionButtons();
      draw();
      resolve();
    };
    img.onerror = () => reject(new Error("图片加载失败"));
    img.src = src;
  });
}

/* ------------------------------ 标注交互 ------------------------------ */

function onMouseDown(event) {
  if (!image) {
    return;
  }

  const { x, y } = toCanvasCoords(event);
  isDrawing = true;

  if (currentTool === "freehand") {
    currentShape = {
      type: "freehand",
      points: [{ x, y }],
      color,
      lineWidth,
    };
  } else if (currentTool === "text") {
    // 文字工具不在拖动中绘制，点击后直接用 prompt 取文本并落定。
    const text = window.prompt("请输入文字：");
    if (text) {
      shapes.push({
        type: "text",
        x,
        y,
        text,
        color,
        fontSize: Math.max(16, lineWidth * 4),
      });
      updateActionButtons();
      draw();
    }
    isDrawing = false;
    currentShape = null;
  } else {
    currentShape = {
      type: currentTool,
      x1: x,
      y1: y,
      x2: x,
      y2: y,
      color,
      lineWidth,
    };
  }
}

function onMouseMove(event) {
  if (!isDrawing || !currentShape) {
    return;
  }

  const { x, y } = toCanvasCoords(event);

  if (currentShape.type === "freehand") {
    currentShape.points.push({ x, y });
  } else {
    currentShape.x2 = x;
    currentShape.y2 = y;
  }

  draw();
}

function onMouseUp() {
  if (!isDrawing) {
    return;
  }

  isDrawing = false;

  if (currentShape) {
    // 把矩形/直线类图形的 x1y1/x2y2 归一化成 x/y/w/h 或保持线段，便于绘制函数统一处理。
    if (currentShape.type === "rect") {
      currentShape.x = Math.min(currentShape.x1, currentShape.x2);
      currentShape.y = Math.min(currentShape.y1, currentShape.y2);
      currentShape.w = Math.abs(currentShape.x2 - currentShape.x1);
      currentShape.h = Math.abs(currentShape.y2 - currentShape.y1);
    }

    // 拖拽距离过短视为误触，丢弃。
    const isTooSmall =
      currentShape.type === "rect"
        ? currentShape.w < 3 || currentShape.h < 3
        : currentShape.type === "freehand"
          ? currentShape.points.length < 2
          : Math.abs(currentShape.x2 - currentShape.x1) < 3 &&
            Math.abs(currentShape.y2 - currentShape.y1) < 3;

    if (!isTooSmall) {
      shapes.push(currentShape);
      updateActionButtons();
    }

    currentShape = null;
    draw();
  }
}

function setTool(tool) {
  currentTool = tool;
  toolButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tool === tool);
  });
}

/* ------------------------------ 操作按钮 ------------------------------ */

function updateActionButtons() {
  const hasImage = image !== null;
  btnUndo.disabled = !hasImage || shapes.length === 0;
  btnClear.disabled = !hasImage || shapes.length === 0;
  btnCopy.disabled = !hasImage;
  btnSave.disabled = !hasImage;
}

function undo() {
  shapes.pop();
  updateActionButtons();
  draw();
}

function clearAnnotations() {
  shapes = [];
  updateActionButtons();
  draw();
}

/**
 * 把画布（背景截图 + 标注）导出为 PNG data URL。
 *
 * 画布内部分辨率就是截图原始尺寸，toDataURL 直接输出全分辨率 PNG，
 * 标注也是按原始像素绘制的，因此导出结果不会因显示缩放而模糊。
 */
function exportDataUrl() {
  return canvas.toDataURL("image/png");
}

async function saveImage() {
  if (!image) {
    return;
  }

  if (!window.dasktop?.has?.("fs:save")) {
    setStatus("未获得文件保存权限", "error");
    return;
  }

  try {
    const path = await dasktop.file.save(
      `screenshot-${Date.now()}.png`,
      dataUrlPayload(exportDataUrl()),
    );

    if (!path) {
      setStatus("已取消保存", "muted");
      return;
    }

    setStatus(`图片已保存到 ${path}`, "ok");
    notify("截图工具", `图片已保存到 ${path}`);
  } catch (error) {
    setStatus(`保存失败：${error.message || error}`, "error");
  }
}

async function copyImage() {
  if (!image) {
    return;
  }

  if (!window.dasktop?.has?.("clipboard:write")) {
    setStatus("未获得剪贴板权限", "error");
    return;
  }

  try {
    await dasktop.clipboard.writeImage(dataUrlPayload(exportDataUrl()));
    setStatus("图片已复制到剪贴板，可粘贴到画图 / Word / 微信等", "ok");
    notify("截图工具", "图片已复制到剪贴板");
  } catch (error) {
    setStatus(`复制失败：${error.message || error}`, "error");
  }
}

/* ------------------------------ 初始化 ------------------------------ */

function bindEvents() {
  toolButtons.forEach((btn) => {
    btn.addEventListener("click", () => setTool(btn.dataset.tool));
  });

  colorInput.addEventListener("input", () => {
    color = colorInput.value;
  });
  lineWidthSelect.addEventListener("change", () => {
    lineWidth = Number(lineWidthSelect.value);
  });

  canvas.addEventListener("mousedown", onMouseDown);
  canvas.addEventListener("mousemove", onMouseMove);
  canvas.addEventListener("mouseup", onMouseUp);
  canvas.addEventListener("mouseleave", onMouseUp);

  btnCapture.addEventListener("click", captureScreen);
  btnUndo.addEventListener("click", undo);
  btnClear.addEventListener("click", clearAnnotations);
  btnCopy.addEventListener("click", copyImage);
  btnSave.addEventListener("click", saveImage);
}

function checkBridge() {
  if (!window.dasktop) {
    setStatus("宿主能力桥不可用，请在 Dasktop 中打开本插件", "error");
    btnCapture.disabled = true;
    return;
  }

  if (!dasktop.has("screen:capture")) {
    btnCapture.disabled = true;
    setStatus("未获得屏幕截图权限", "error");
  }
}

bindEvents();
checkBridge();
