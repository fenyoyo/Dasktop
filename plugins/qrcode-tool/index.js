/*
 * 二维码工具逻辑。
 *
 * 功能：生成二维码到 canvas，解析图片中的二维码。
 * 依赖两个 UMD 库：qrcode.js（生成）与 jsQR.js（解析）。
 * 宿主能力：clipboard:read / clipboard:write / fs:save / screen:capture / ui:notify。
 */

const STORAGE_KEY = "qrcode-tool:generate-text";

const generateInput = document.getElementById("generate-input");
const generateLevel = document.getElementById("generate-level");
const generateCell = document.getElementById("generate-cell");
const generateMargin = document.getElementById("generate-margin");
const generateBtn = document.getElementById("generate-btn");
const generateCopyText = document.getElementById("generate-copy-text");
const generateCopyImage = document.getElementById("generate-copy-image");
const generateSave = document.getElementById("generate-save");
const generateCanvas = document.getElementById("generate-canvas");
const generatePlaceholder = document.getElementById("generate-placeholder");

const scanDrop = document.getElementById("scan-drop");
const scanFile = document.getElementById("scan-file");
const scanPaste = document.getElementById("scan-paste");
const scanSelect = document.getElementById("scan-select");
const scanScreenshot = document.getElementById("scan-screenshot");
const scanPreview = document.getElementById("scan-preview");
const scanResult = document.getElementById("scan-result");
const scanCopy = document.getElementById("scan-copy");
const scanClear = document.getElementById("scan-clear");

const tabGenerate = document.getElementById("tab-generate");
const tabScan = document.getElementById("tab-scan");
const panelGenerate = document.getElementById("panel-generate");
const panelScan = document.getElementById("panel-scan");
const statusBar = document.getElementById("status");

let lastGeneratedDataUrl = null;

/* ------------------------------ 宿主能力封装 ------------------------------ */

/**
 * 把文本写入剪贴板。失败时抛出宿主返回的错误。
 */
async function copyText(text) {
  if (!window.dasktop) {
    throw new Error("宿主能力桥不可用");
  }

  await dasktop.clipboard.write(text);
}

/**
 * 向宿主发送通知。失败时不阻塞主流程。
 */
async function notify(title, message) {
  if (!window.dasktop || !dasktop.has("ui:notify")) {
    return;
  }

  try {
    await dasktop.notify.send(title, message);
  } catch {
    // 通知失败不是主流程错误，静默忽略。
  }
}

/* ------------------------------ 通用 UI ------------------------------ */

function setStatus(text, kind = "muted") {
  statusBar.textContent = text;
  statusBar.className = `status ${kind}`;
}

function switchTab(tab) {
  const isGenerate = tab === "generate";

  tabGenerate.classList.toggle("active", isGenerate);
  tabScan.classList.toggle("active", !isGenerate);
  panelGenerate.classList.toggle("active", isGenerate);
  panelScan.classList.toggle("active", !isGenerate);
}

/* ------------------------------ 生成二维码 ------------------------------ */

/**
 * 用 qrcode.js 生成 QR 模块，并在 canvas 上绘制。
 *
 * @param {string} text 要编码的内容
 * @param {string} level 纠错级别 L/M/Q/H
 * @param {number} cellSize 每个模块的像素大小
 * @param {number} margin 二维码外边的白边模块数
 */
function drawQrCode(text, level, cellSize, margin) {
  const qr = qrcode(0, level);
  qr.addData(text);
  qr.make();

  const count = qr.getModuleCount();
  const size = (count + margin * 2) * cellSize;

  generateCanvas.width = size;
  generateCanvas.height = size;

  const ctx = generateCanvas.getContext("2d");

  // 白底
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);

  // 黑模块
  ctx.fillStyle = "#000000";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) {
        ctx.fillRect((col + margin) * cellSize, (row + margin) * cellSize, cellSize, cellSize);
      }
    }
  }

  generateCanvas.classList.add("visible");
  lastGeneratedDataUrl = generateCanvas.toDataURL("image/png");

  generateCopyImage.disabled = false;
  generateSave.disabled = false;
}

async function handleGenerate() {
  const text = generateInput.value;

  if (!text) {
    setStatus("请输入要生成二维码的内容", "error");
    return;
  }

  const level = generateLevel.value;
  const cellSize = Math.max(2, Math.min(20, Number(generateCell.value) || 6));
  const margin = Math.max(0, Math.min(10, Number(generateMargin.value) || 2));

  try {
    drawQrCode(text, level, cellSize, margin);
    localStorage.setItem(STORAGE_KEY, text);
    setStatus("二维码已生成", "ok");
    await notify("二维码工具", "二维码已生成");
  } catch (error) {
    setStatus(`生成失败：${error.message || error}`, "error");
  }
}

async function handleCopyGenerateText() {
  const text = generateInput.value;

  if (!text) {
    setStatus("没有可复制的内容", "error");
    return;
  }

  try {
    await copyText(text);
    setStatus("内容已复制", "ok");
  } catch (error) {
    setStatus(`复制失败：${error.message || error}`, "error");
  }
}

/**
 * 把 canvas 内容写入剪贴板图片。由于能力桥当前不直接暴露图片写入，
 * 先尝试 Clipboard API；不可用时报错提示用户保存。
 */
async function handleCopyGenerateImage() {
  if (!lastGeneratedDataUrl) {
    setStatus("没有可复制的图片", "error");
    return;
  }

  try {
    const blob = await (await fetch(lastGeneratedDataUrl)).blob();

    if (navigator.clipboard && navigator.clipboard.write) {
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      setStatus("图片已复制到剪贴板", "ok");
      await notify("二维码工具", "图片已复制到剪贴板");
    } else {
      throw new Error("当前环境不支持写入图片剪贴板");
    }
  } catch (error) {
    setStatus(`复制图片失败：${error.message || error}`, "error");
  }
}

/**
 * 从 data URL 中取出 base64 载荷。
 *
 * 宿主保存文件只接受纯 base64（不含 `data:<mime>;base64,` 前缀），而 canvas 与宿主的
 * 图片能力给出的都是 data URL，所以在这条边界上剥一次前缀。
 *
 * @param {string} dataUrl 完整的 data URL
 * @returns {string} base64 载荷
 */
function dataUrlPayload(dataUrl) {
  const commaIndex = dataUrl.indexOf(",");

  return commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
}

/**
 * 保存生成的二维码图片。
 *
 * 走宿主能力 `fs:save`：宿主会弹出系统保存对话框，由用户当场决定落在哪个目录，并把
 * 最终路径回传。之前用 `<a download>` 是行不通的——WebView2 会静默存到默认下载目录，
 * 用户既没得选、也无从知道文件去哪了，而「提示保存路径」恰恰是这一步的要点。
 */
async function handleSaveGenerateImage() {
  if (!lastGeneratedDataUrl) {
    setStatus("没有可保存的图片", "error");
    return;
  }

  if (!window.dasktop || !dasktop.has("fs:save")) {
    setStatus("未获得文件保存权限，无法保存图片", "error");
    return;
  }

  try {
    const path = await dasktop.file.save(
      `qrcode-${Date.now()}.png`,
      dataUrlPayload(lastGeneratedDataUrl),
    );

    // 用户点了「取消」：这不是失败，正常告知即可。
    if (!path) {
      setStatus("已取消保存", "muted");
      return;
    }

    setStatus(`图片已保存到 ${path}`, "ok");
    await notify("二维码工具", `图片已保存到 ${path}`);
  } catch (error) {
    setStatus(`保存失败：${error.message || error}`, "error");
  }
}

/* ------------------------------ 解析二维码 ------------------------------ */

/**
 * 在 canvas 上把图片绘制为 ImageData，供 jsQR 解析。
 */
function getImageDataFromImage(image) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;

  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);

  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * 用 jsQR 解析图片数据。解析失败时返回 null。
 */
function decodeQrCode(imageData) {
  return jsQR(imageData.data, imageData.width, imageData.height, {
    inversionAttempts: "attemptBoth",
  });
}

/**
 * 显示待解析的图片。
 *
 * 图片就地落在拖放框里，与空态提示共用同一个盒子：切换 `has-image` 让拖放框收起
 * 「拖放 / 粘贴 / 点选」提示、改显示图片本身，因此解析页不再需要独立的预览区。
 * 拖放框仍保持可点击，点图片即可重新选一张替换。
 */
function displayScanImage(src) {
  scanPreview.src = src;
  scanDrop.classList.add("has-image");
}

function clearScanPreview() {
  scanPreview.src = "";
  scanDrop.classList.remove("has-image");
  scanResult.value = "";
  scanCopy.disabled = true;
}

/**
 * 加载图片来源并解析其中的二维码。src 支持 blob URL、data URL 等浏览器可加载的形式，
 * 让「本地文件」与「屏幕截图」两条输入路径共用同一套解码流程。
 *
 * @param {string} src 图片地址
 */
async function processImageSource(src) {
  displayScanImage(src);

  const image = new Image();

  // 先挂事件再赋 src：本地 blob / data URL 可能命中缓存，载入回调有机会在赋值同一轮
  // 就被触发，反过来写会漏掉这次回调，表现为「选了图却一直没结果」。
  image.onload = async () => {
    try {
      const imageData = getImageDataFromImage(image);
      const result = decodeQrCode(imageData);

      if (result) {
        scanResult.value = result.data;
        scanCopy.disabled = false;
        setStatus("解析成功", "ok");
        await notify("二维码工具", "二维码解析成功");
      } else {
        scanResult.value = "";
        scanCopy.disabled = true;
        setStatus("未能识别二维码，请尝试更清晰的图片", "error");
      }
    } catch (error) {
      setStatus(`解析失败：${error.message || error}`, "error");
    }
  };

  image.onerror = () => {
    setStatus("图片加载失败", "error");
  };

  image.src = src;
}

async function processImageFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    setStatus("请选择图片文件", "error");
    return;
  }

  // 这一步的异常必须落到状态栏：调用方是 change / drop 事件的监听器，没人接住 rejection，
  // 一旦抛错用户看到的就是「点了完全没反应」，而真正原因只留在控制台里。
  try {
    await processImageSource(URL.createObjectURL(file));
  } catch (error) {
    setStatus(`读取图片失败：${error.message || error}`, "error");
  }
}

/**
 * 从剪贴板粘贴：把剪贴板里的图片直接拿去做解析。
 *
 * 走宿主能力 `clipboard:read` 的图片接口，不依赖浏览器 Clipboard API——插件页面跑在
 * 自定义协议下，`navigator.clipboard.read()` 会被权限判定直接拒掉，这正是这条路径原先
 * 点了没反应的原因。宿主返回的是已经按实际格式拼好 MIME 的完整 data URL（位图会编码成
 * PNG，在资源管理器里复制的图片文件则按原格式透传），所以这里不能再写死图片类型，
 * 拿到什么就直接交给同一条解码流程。
 */
async function handlePasteScan() {
  try {
    const dataUrl = await dasktop.clipboard.readImage();

    if (!dataUrl) {
      // 剪贴板里没有图片（比如复制的是文字）属于正常情况，引导用户改成复制一张图片。
      setStatus("剪贴板中没有图片，请复制一张图片或图片文件后再粘贴", "error");
      return;
    }

    await processImageSource(dataUrl);
  } catch (error) {
    setStatus(`粘贴失败：${error.message || error}`, "error");
  }
}

/**
 * 截屏识别：调用宿主能力弹出全屏框选层，由用户亲手框出二维码所在区域。
 *
 * 该调用会一直等待用户在屏幕上完成框选，因此这里不锁界面，只在状态栏提示当前进度；
 * 用户取消框选时宿主返回 null，按「主动放弃」提示，而不是当成错误。
 */
async function handleScreenshotScan() {
  if (!window.dasktop || !dasktop.has("screen:capture")) {
    setStatus("未获得屏幕截图权限，无法截屏识别", "error");
    return;
  }

  setStatus("请在屏幕上拖拽框选二维码区域，按 Esc 取消");

  try {
    const base64 = await dasktop.screen.capture();

    if (!base64) {
      setStatus("已取消截屏", "muted");
      return;
    }

    await processImageSource(`data:image/png;base64,${base64}`);
  } catch (error) {
    setStatus(`截屏失败：${error.message || error}`, "error");
  }
}

function handleSelectFile() {
  scanFile.click();
}

function handleFileInputChange(event) {
  const file = event.target.files[0];

  if (file) {
    processImageFile(file);
  }
}

function handleDragOver(event) {
  event.preventDefault();
  scanDrop.classList.add("drag-over");
}

function handleDragLeave() {
  scanDrop.classList.remove("drag-over");
}

async function handleDrop(event) {
  event.preventDefault();
  scanDrop.classList.remove("drag-over");

  const file = event.dataTransfer.files[0];

  if (file) {
    await processImageFile(file);
  }
}

async function handleCopyScanResult() {
  const text = scanResult.value;

  if (!text) {
    setStatus("没有可复制的结果", "error");
    return;
  }

  try {
    await copyText(text);
    setStatus("结果已复制", "ok");
  } catch (error) {
    setStatus(`复制失败：${error.message || error}`, "error");
  }
}

/* ------------------------------ 初始化 ------------------------------ */

function bindEvents() {
  tabGenerate.addEventListener("click", () => switchTab("generate"));
  tabScan.addEventListener("click", () => switchTab("scan"));

  generateBtn.addEventListener("click", handleGenerate);
  generateCopyText.addEventListener("click", handleCopyGenerateText);
  generateCopyImage.addEventListener("click", handleCopyGenerateImage);
  generateSave.addEventListener("click", handleSaveGenerateImage);

  scanDrop.addEventListener("click", handleSelectFile);
  scanDrop.addEventListener("dragover", handleDragOver);
  scanDrop.addEventListener("dragleave", handleDragLeave);
  scanDrop.addEventListener("drop", handleDrop);
  scanDrop.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleSelectFile();
    }
  });

  scanFile.addEventListener("change", handleFileInputChange);
  scanScreenshot.addEventListener("click", handleScreenshotScan);
  scanPaste.addEventListener("click", handlePasteScan);
  scanSelect.addEventListener("click", handleSelectFile);
  scanCopy.addEventListener("click", handleCopyScanResult);
  scanClear.addEventListener("click", clearScanPreview);

  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "v" && tabScan.classList.contains("active")) {
      event.preventDefault();
      handlePasteScan();
    }
  });
}

function restoreState() {
  const saved = localStorage.getItem(STORAGE_KEY);

  if (saved) {
    generateInput.value = saved;
  }
}

function checkBridge() {
  if (!window.dasktop) {
    setStatus("宿主能力桥不可用：这个页面不是由 Dasktop 打开的。复制/通知功能将不可用。");
    generateCopyText.disabled = true;
    generateCopyImage.disabled = true;
    scanPaste.disabled = true;
    scanScreenshot.disabled = true;
    scanCopy.disabled = true;
    return;
  }

  if (!dasktop.has("clipboard:read")) {
    scanPaste.disabled = true;
  }

  if (!dasktop.has("screen:capture")) {
    scanScreenshot.disabled = true;
  }

  if (!dasktop.has("clipboard:write")) {
    generateCopyText.disabled = true;
    scanCopy.disabled = true;
  }
}

bindEvents();
restoreState();
checkBridge();