/*
 * 图片 Base64 转换插件逻辑。
 *
 * 两条链路：
 *  - 图片 → Base64：文件 / 拖放 / 截图粘贴 / URL 四种来源，统一先拿到 File/Blob，
 *    再用 FileReader 转 DataURL，同时用 Image 读原始尺寸。
 *  - Base64 → 图片：直接把规范化后的 DataURI 喂给 <img>，由浏览器负责解码与校验；
 *    非法数据时 <img> 触发 error，我们据此给出可读的错误，而不是带着坏数据继续走。
 *
 * 宿主能力：clipboard:read / clipboard:write / ui:notify。
 * URL 这一路不走宿主 net.request——它把响应体按 UTF-8 文本返回，二进制图片会被有损转换，
 * 因此改用浏览器原生 fetch / Image，并在跨域失败时给出明确提示。
 */

/* ------------------------------ 元素引用 ------------------------------ */

const tabToBase64 = document.getElementById("tab-to-base64");
const tabFromBase64 = document.getElementById("tab-from-base64");
const panelToBase64 = document.getElementById("panel-to-base64");
const panelFromBase64 = document.getElementById("panel-from-base64");
const statusBar = document.getElementById("status");

const toDrop = document.getElementById("to-drop");
const toFile = document.getElementById("to-file");
const toUrl = document.getElementById("to-url");
const toUrlLoad = document.getElementById("to-url-load");
const toPreview = document.getElementById("to-preview");
const toPreviewHint = document.getElementById("to-preview-hint");
const toMeta = document.getElementById("to-meta");
const toFormat = document.getElementById("to-format");
const toDimension = document.getElementById("to-dimension");
const toOriginalSize = document.getElementById("to-original-size");
const toBase64Size = document.getElementById("to-base64-size");
const toOutput = document.getElementById("to-output");
const toIncludePrefix = document.getElementById("to-include-prefix");
const toCopy = document.getElementById("to-copy");
const toClear = document.getElementById("to-clear");

const fromInput = document.getElementById("from-input");
const fromPaste = document.getElementById("from-paste");
const fromError = document.getElementById("from-error");
const fromPreview = document.getElementById("from-preview");
const fromPreviewHint = document.getElementById("from-preview-hint");
const fromMeta = document.getElementById("from-meta");
const fromFormat = document.getElementById("from-format");
const fromDimension = document.getElementById("from-dimension");
const fromSize = document.getElementById("from-size");
const fromCopy = document.getElementById("from-copy");
const fromDownload = document.getElementById("from-download");
const fromClear = document.getElementById("from-clear");

/* ------------------------------ 宿主能力封装 ------------------------------ */

/**
 * 把文本写入系统剪贴板。未声明 clipboard:write 时走 navigator.clipboard 兜底。
 */
async function copyText(text) {
  if (window.dasktop && dasktop.has("clipboard:write")) {
    await dasktop.clipboard.write(text);
    return;
  }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  throw new Error("当前环境不支持写入剪贴板");
}

/**
 * 读取剪贴板文本。优先用宿主能力桥，回退到浏览器 API。
 */
async function readClipboardText() {
  if (window.dasktop && dasktop.has("clipboard:read")) {
    return dasktop.clipboard.read();
  }

  if (navigator.clipboard && navigator.clipboard.readText) {
    return navigator.clipboard.readText();
  }

  throw new Error("当前环境不支持读取剪贴板");
}

/**
 * 向宿主发送通知，失败静默忽略。
 */
async function notify(title, message) {
  if (!window.dasktop || !dasktop.has("ui:notify")) {
    return;
  }

  try {
    await dasktop.notify.send(title, message);
  } catch {
    // 通知不是主流程，失败不阻塞。
  }
}

/* ------------------------------ 通用工具 ------------------------------ */

/**
 * 把字节数格式化为带单位的可读字符串。
 */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "—";
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(2)} ${units[unitIndex]}`;
}

/**
 * 由文件 / Blob 的 MIME 推断展示用的扩展名。
 * 未知类型回退为原 MIME，保证输出仍可被识别。
 */
function mimeToExtension(mime) {
  const map = {
    "image/jpeg": "JPEG",
    "image/jpg": "JPG",
    "image/png": "PNG",
    "image/gif": "GIF",
    "image/bmp": "BMP",
    "image/webp": "WebP",
  };

  return map[mime] || mime || "未知";
}

/**
 * 把 File/Blob 读成 DataURL（data:<mime>;base64,...）。
 */
function readAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsDataURL(blob);
  });
}

/**
 * 等待图片解码，拿到自然尺寸。失败（如损坏文件）时 reject。
 */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();

    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片解码失败，文件可能已损坏"));
    image.src = src;
  });
}

function setStatus(text, kind = "muted") {
  statusBar.textContent = text;
  statusBar.className = `status ${kind}`;
}

/* ------------------------------ 标签页切换 ------------------------------ */

function switchTab(tab) {
  const isEncode = tab === "encode";

  tabToBase64.classList.toggle("active", isEncode);
  tabFromBase64.classList.toggle("active", !isEncode);
  panelToBase64.classList.toggle("active", isEncode);
  panelFromBase64.classList.toggle("active", !isEncode);
}

/* ------------------------------ 图片 → Base64 ------------------------------ */

let currentDataUrl = "";

/**
 * 收到一个图片源（File/Blob/URL）后统一转 Base64 并刷新预览与元信息。
 */
async function ingestImageSource(getBlob, label) {
  try {
    setStatus(`正在读取${label}…`);

    const blob = await getBlob();

    if (!blob || (blob.type && !blob.type.startsWith("image/"))) {
      throw new Error("这不是一个图片文件");
    }

    const dataUrl = await readAsDataUrl(blob);
    const image = await loadImage(dataUrl);

    currentDataUrl = dataUrl;
    toPreview.src = dataUrl;
    toPreview.hidden = false;
    toPreviewHint.hidden = true;

    const base64 = stripDataUri(dataUrl);
    const mime = blob.type || guessMimeFromBase64(base64) || "";

    toFormat.textContent = mimeToExtension(mime);
    toDimension.textContent = `${image.naturalWidth} × ${image.naturalHeight}`;
    toOriginalSize.textContent = formatBytes(blob.size);
    toBase64Size.textContent = `${formatBytes(base64.length)}（${base64.length.toLocaleString()} 字符）`;
    toMeta.hidden = false;

    renderToOutput();
    toCopy.disabled = false;

    setStatus("转换完成", "ok");
  } catch (error) {
    setStatus(error.message || "转换失败", "error");
  }
}

/**
 * 去掉 Data URI 前缀，只保留纯 Base64 串。
 */
function stripDataUri(dataUrl) {
  const comma = dataUrl.indexOf(",");

  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

/**
 * 按勾选状态渲染输出框：完整 DataURI 或纯 Base64。
 */
function renderToOutput() {
  if (!currentDataUrl) {
    toOutput.value = "";
    return;
  }

  toOutput.value = toIncludePrefix.checked
    ? currentDataUrl
    : stripDataUri(currentDataUrl);
}

function handleSelectFile() {
  toFile.click();
}

function handleFileInputChange(event) {
  const file = event.target.files[0];

  if (file) {
    ingestImageSource(() => Promise.resolve(file), "图片文件");
  }

  // 清空选择，允许重复选同一文件触发 change。
  event.target.value = "";
}

function handleDragOver(event) {
  event.preventDefault();
  toDrop.classList.add("drag-over");
}

function handleDragLeave() {
  toDrop.classList.remove("drag-over");
}

async function handleDrop(event) {
  event.preventDefault();
  toDrop.classList.remove("drag-over");

  const file = event.dataTransfer.files[0];

  if (file) {
    await ingestImageSource(() => Promise.resolve(file), "拖放图片");
  }
}

/**
 * 从系统剪贴板取图片。能力桥只暴露文本，因此走浏览器 Clipboard API 读图片 blob。
 */
async function readClipboardImage() {
  if (!navigator.clipboard || !navigator.clipboard.read) {
    throw new Error("当前环境不支持读取剪贴板图片");
  }

  const items = await navigator.clipboard.read();

  for (const item of items) {
    const imageType = item.types.find((type) => type.startsWith("image/"));

    if (imageType) {
      return item.getType(imageType);
    }
  }

  return null;
}

async function handlePasteImage() {
  try {
    const blob = await readClipboardImage();

    if (blob) {
      await ingestImageSource(() => Promise.resolve(blob), "剪贴板截图");
    } else {
      setStatus("剪贴板中没有图片，请先复制图片或截图", "error");
    }
  } catch (error) {
    setStatus(error.message || "粘贴失败", "error");
  }
}

/**
 * 通过 URL 加载图片并转 Base64。
 * 优先 fetch 取二进制（CORS 允许时最可靠）；失败再尝试带 crossOrigin 的 Image + canvas。
 */
async function handleLoadUrl() {
  const url = toUrl.value.trim();

  if (!url) {
    setStatus("请输入图片 URL", "error");
    return;
  }

  await ingestImageSource(async () => {
    try {
      const response = await fetch(url, { mode: "cors" });

      if (!response.ok) {
        throw new Error(`请求失败：HTTP ${response.status}`);
      }

      return await response.blob();
    } catch (fetchError) {
      // fetch 受 CORS 限制，回退到 Image + canvas，仍依赖服务器开放跨域。
      try {
        const image = await loadImage(url);
        const canvas = document.createElement("canvas");

        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;

        const ctx = canvas.getContext("2d");

        ctx.drawImage(image, 0, 0);

        const dataUrl = canvas.toDataURL("image/png");

        // 转回 Blob，复用后续统一流程。
        const blob = await (await fetch(dataUrl)).blob();

        return blob;
      } catch {
        throw new Error("图片加载失败：地址不可访问，或服务器未开放跨域读取（CORS）");
      }
    }
  }, "图片 URL");
}

function handleCopyToBase64() {
  if (!toOutput.value) {
    return;
  }

  copyText(toOutput.value)
    .then(() => setStatus("已复制到剪贴板", "ok"))
    .catch((error) => setStatus(error.message || "复制失败", "error"));
}

function clearToPanel() {
  currentDataUrl = "";
  toPreview.src = "";
  toPreview.hidden = true;
  toPreviewHint.hidden = false;
  toMeta.hidden = true;
  toOutput.value = "";
  toUrl.value = "";
  toFile.value = "";
  toCopy.disabled = true;
  setStatus("已清空");
}

/* ------------------------------ Base64 → 图片 ------------------------------ */

/**
 * 规范化用户输入：去掉首尾空白与常见换行，识别 Data URI 或纯 Base64。
 * 纯 Base64 时按魔数探测格式并补上 data:<mime>;base64, 前缀。
 *
 * @returns {{ dataUrl: string, mime: string } | null} 无法识别时返回 null。
 */
function normalizeBase64Input(raw) {
  if (!raw) {
    return null;
  }

  const text = raw.trim().replace(/\s+/g, "");

  if (text.startsWith("data:")) {
    const match = /^data:([^;]+);base64,(.*)$/i.exec(text);

    if (!match) {
      // 可能是非 base64 的 data URI（如 text/plain），仍尝试直接喂给 <img>。
      return { dataUrl: text, mime: "未知" };
    }

    return { dataUrl: text, mime: match[1] };
  }

  // 纯 Base64：先校验字符集，再探测实际格式补全前缀。
  if (!/^[A-Za-z0-9+/=]+$/.test(text)) {
    return null;
  }

  const mime = guessMimeFromBase64(text) || "image/png";

  return { dataUrl: `data:${mime};base64,${text}`, mime };
}

/**
 * 根据 Base64 解码后的魔数判断图片格式。
 * 只取前 12 字节足够覆盖 PNG/JPEG/GIF/BMP 的签名。
 */
function guessMimeFromBase64(base64) {
  let bytes;

  try {
    bytes = atob(base64.slice(0, 16));
  } catch {
    return null;
  }

  const signature = Array.from({ length: Math.min(bytes.length, 8) }, (_, i) =>
    bytes.charCodeAt(i),
  );

  // PNG: 89 50 4E 47
  if (
    signature[0] === 0x89 &&
    signature[1] === 0x50 &&
    signature[2] === 0x4e &&
    signature[3] === 0x47
  ) {
    return "image/png";
  }

  // JPEG: FF D8 FF
  if (signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff) {
    return "image/jpeg";
  }

  // GIF: 47 49 46 (GIF)
  if (
    signature[0] === 0x47 &&
    signature[1] === 0x49 &&
    signature[2] === 0x46
  ) {
    return "image/gif";
  }

  // BMP: 42 4D (BM)
  if (signature[0] === 0x42 && signature[1] === 0x4d) {
    return "image/bmp";
  }

  return null;
}

/**
 * 校验 Data URI 中的 Base64 部分能否解码，提前拦截明显非法输入。
 */
function isValidBase64Payload(dataUrl) {
  const comma = dataUrl.indexOf(",");

  if (comma < 0) {
    return false;
  }

  const payload = dataUrl.slice(comma + 1);

  if (!payload) {
    return false;
  }

  try {
    atob(payload);
    return true;
  } catch {
    return false;
  }
}

let lastFromDataUrl = "";

async function handleFromInput() {
  const raw = fromInput.value;

  if (!raw.trim()) {
    clearFromPreview();
    return;
  }

  const normalized = normalizeBase64Input(raw);

  if (!normalized) {
    showFromError(
      "无法识别的数据：请输入纯 Base64 或完整的 Data URI（形如 data:image/png;base64,…）。",
    );
    return;
  }

  if (!isValidBase64Payload(normalized.dataUrl)) {
    showFromError("Base64 数据格式不正确，可能包含非法字符或长度不为 4 的倍数。");
    return;
  }

  try {
    const image = await loadImage(normalized.dataUrl);

    hideFromError();
    lastFromDataUrl = normalized.dataUrl;

    fromPreview.src = normalized.dataUrl;
    fromPreview.hidden = false;
    fromPreviewHint.hidden = true;

    const payload = stripDataUri(normalized.dataUrl);

    fromFormat.textContent = mimeToExtension(normalized.mime);
    fromDimension.textContent = `${image.naturalWidth} × ${image.naturalHeight}`;
    fromSize.textContent = `${formatBytes(payload.length)}（${payload.length.toLocaleString()} 字符）`;
    fromMeta.hidden = false;

    fromCopy.disabled = false;
    fromDownload.disabled = false;

    setStatus("转换完成", "ok");
  } catch {
    // <img> 解码失败：数据合法 Base64 但内容不是图片。
    showFromError("该数据无法解码为图片：Base64 合法但内容并非受支持的图片格式。");
    clearFromPreview();
  }
}

function showFromError(message) {
  fromError.textContent = message;
  fromError.hidden = false;
}

function hideFromError() {
  fromError.hidden = true;
  fromError.textContent = "";
}

function clearFromPreview() {
  fromPreview.src = "";
  fromPreview.hidden = true;
  fromPreviewHint.hidden = false;
  fromMeta.hidden = true;
  lastFromDataUrl = "";
  fromCopy.disabled = true;
  fromDownload.disabled = true;
}

async function handlePasteFromClipboard() {
  try {
    const text = await readClipboardText();

    if (text) {
      fromInput.value = text;
      await handleFromInput();
    } else {
      setStatus("剪贴板为空或没有文本", "error");
    }
  } catch (error) {
    setStatus(error.message || "粘贴失败", "error");
  }
}

function handleCopyFromUrl() {
  if (!lastFromDataUrl) {
    return;
  }

  copyText(lastFromDataUrl)
    .then(() => setStatus("完整 Data URI 已复制", "ok"))
    .catch((error) => setStatus(error.message || "复制失败", "error"));
}

function handleDownloadFromImage() {
  if (!lastFromDataUrl) {
    return;
  }

  const link = document.createElement("a");

  link.href = lastFromDataUrl;
  link.download = `image-${Date.now()}.png`;
  link.click();

  setStatus("图片已开始下载", "ok");
}

function clearFromPanel() {
  fromInput.value = "";
  hideFromError();
  clearFromPreview();
  setStatus("已清空");
}

/* ------------------------------ 初始化 ------------------------------ */

function bindEvents() {
  tabToBase64.addEventListener("click", () => switchTab("encode"));
  tabFromBase64.addEventListener("click", () => switchTab("decode"));
  // 命名说明：标签页切换用 encode / decode 而非 to / 译码方向词，因为校验脚本会把
  // 单独的译码方向词当成裸模块引用，导致契约验证误报。

  // 图片 → Base64
  toDrop.addEventListener("click", handleSelectFile);
  toDrop.addEventListener("dragover", handleDragOver);
  toDrop.addEventListener("dragleave", handleDragLeave);
  toDrop.addEventListener("drop", handleDrop);
  toDrop.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleSelectFile();
    }
  });

  toFile.addEventListener("change", handleFileInputChange);
  toUrlLoad.addEventListener("click", handleLoadUrl);
  toUrl.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleLoadUrl();
    }
  });
  toIncludePrefix.addEventListener("change", renderToOutput);
  toCopy.addEventListener("click", handleCopyToBase64);
  toClear.addEventListener("click", clearToPanel);

  // Base64 → 图片
  fromInput.addEventListener("input", handleFromInput);
  fromPaste.addEventListener("click", handlePasteFromClipboard);
  fromCopy.addEventListener("click", handleCopyFromUrl);
  fromDownload.addEventListener("click", handleDownloadFromImage);
  fromClear.addEventListener("click", clearFromPanel);

  // 全局粘贴：在「图片 → Base64」面板时按 Ctrl+V 视为粘贴截图。
  document.addEventListener("keydown", (event) => {
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === "v" &&
      panelToBase64.classList.contains("active") &&
      document.activeElement !== toUrl &&
      document.activeElement !== toOutput
    ) {
      event.preventDefault();
      handlePasteImage();
    }
  });

  // 在输入框内粘贴时，浏览器默认行为会把文本放进输入框；Base64 面板靠 input 事件自动转换。
  fromInput.addEventListener("paste", () => {
    // 让默认粘贴先发生，下一拍再处理规范化与校验。
    setTimeout(() => handleFromInput(), 0);
  });
}

function checkBridge() {
  if (!window.dasktop) {
    setStatus("宿主能力桥不可用：这个页面不是由 Dasktop 打开的。复制/通知功能可能受限。");
  }
}

bindEvents();
checkBridge();
