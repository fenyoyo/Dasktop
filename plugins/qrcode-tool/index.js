/*
 * 二维码工具逻辑。
 *
 * 功能：生成二维码到 canvas，解析图片中的二维码。
 * 依赖两个 UMD 库：qrcode.js（生成）与 jsQR.js（解析）。
 * 宿主能力：clipboard:read / clipboard:write / ui:notify。
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
const scanPreview = document.getElementById("scan-preview");
const scanPreviewHint = document.getElementById("scan-preview-hint");
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
 * 从剪贴板读取文本或图片。能力桥当前只暴露文本读取；图片走剪贴板文本兜底，
 * 后续如果宿主开放二进制剪贴板能力再扩展。
 */
async function readClipboardText() {
  if (!window.dasktop) {
    throw new Error("宿主能力桥不可用");
  }

  return dasktop.clipboard.read();
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

function handleSaveGenerateImage() {
  if (!lastGeneratedDataUrl) {
    setStatus("没有可保存的图片", "error");
    return;
  }

  const link = document.createElement("a");
  link.href = lastGeneratedDataUrl;
  link.download = `qrcode-${Date.now()}.png`;
  link.click();
  setStatus("图片已开始下载", "ok");
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

function displayScanImage(src) {
  scanPreview.src = src;
  scanPreview.hidden = false;
  scanPreview.classList.add("visible");
}

function clearScanPreview() {
  scanPreview.src = "";
  scanPreview.hidden = true;
  scanPreview.classList.remove("visible");
  scanResult.value = "";
  scanCopy.disabled = true;
}

async function processImageFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    setStatus("请选择图片文件", "error");
    return;
  }

  const url = URL.createObjectURL(file);
  displayScanImage(url);

  const image = new Image();
  image.src = url;

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
}

async function handlePasteScan() {
  try {
    // 优先尝试读取系统剪贴板里的图片文件（如果宿主未来支持）。
    // 当前能力桥只暴露文本读取，因此先尝试宿主文本，再回退到 Clipboard API 的图片。
    if (navigator.clipboard && navigator.clipboard.read) {
      const items = await navigator.clipboard.read();

      for (const item of items) {
        const imageType = item.types.find((type) => type.startsWith("image/"));

        if (imageType) {
          const blob = await item.getType(imageType);
          await processImageFile(blob);
          return;
        }
      }
    }

    // 兜底：读取剪贴板文本。如果文本是图片 URL 或 base64，不做额外处理；
    // 更常见的场景是用户复制了图片文件，此时文本读取拿不到东西。
    const text = await readClipboardText();

    if (text) {
      setStatus("剪贴板中是文本而非图片，请复制图片后再粘贴", "error");
    } else {
      setStatus("剪贴板中没有可识别的图片", "error");
    }
  } catch (error) {
    setStatus(`粘贴失败：${error.message || error}`, "error");
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
    scanCopy.disabled = true;
    return;
  }

  if (!dasktop.has("clipboard:read")) {
    scanPaste.disabled = true;
  }

  if (!dasktop.has("clipboard:write")) {
    generateCopyText.disabled = true;
    scanCopy.disabled = true;
  }
}

bindEvents();
restoreState();
checkBridge();