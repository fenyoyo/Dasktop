/*
 * 翻译插件逻辑。
 *
 * 翻译请求统一经宿主能力桥的 net.request 代发：浏览器直连 Google 翻译接口会被 CORS 拦，
 * 而宿主 Rust 侧发出的请求不受同源策略约束，因此这里不自己 fetch。
 * 朗读用浏览器 SpeechSynthesis（无权限要求，不可用时报错提示）；复制用 clipboard:write。
 *
 * 自动翻译开关：打开后随输入自动翻译，关闭则只在点按钮 / 回车时翻译。偏好存 localStorage。
 */

const LANGUAGES = [
  { code: "auto", name: "自动检测" },
  { code: "zh-CN", name: "简体中文" },
  { code: "zh-TW", name: "繁體中文" },
  { code: "en", name: "English" },
  { code: "ja", name: "日本語" },
  { code: "ko", name: "한국어" },
  { code: "fr", name: "Français" },
  { code: "de", name: "Deutsch" },
  { code: "es", name: "Español" },
  { code: "ru", name: "Русский" },
  { code: "pt", name: "Português" },
  { code: "it", name: "Italiano" },
];

const topbar = document.getElementById("topbar");
const srcLang = document.getElementById("src-lang");
const dstLang = document.getElementById("dst-lang");
const swapBtn = document.getElementById("swap");
const source = document.getElementById("source");
const result = document.getElementById("result");
const srcSpeak = document.getElementById("src-speak");
const srcCopy = document.getElementById("src-copy");
const dstSpeak = document.getElementById("dst-speak");
const dstCopy = document.getElementById("dst-copy");
const webToggle = document.getElementById("web-toggle");
const translateBtn = document.getElementById("translate");
const statusBar = document.getElementById("status");

let busy = false;

/* ------------------------------ 初始化 ------------------------------ */

function fillLanguages() {
  for (const select of [srcLang, dstLang]) {
    for (const lang of LANGUAGES) {
      const option = document.createElement("option");
      option.value = lang.code;
      option.textContent = lang.name;
      select.appendChild(option);
    }
  }

  // 默认：自动检测 -> 英文，符合大多数「划词即译」场景。
  srcLang.value = "auto";
  dstLang.value = "en";
}

function restoreWebToggle() {
  webToggle.checked = localStorage.getItem("translator:web") === "1";
}

/* ------------------------------ 翻译 ------------------------------ */

/**
 * 调 Google 翻译（client=gtx 免密钥端点）。宿主代发返回的是 JSON 文本，自行解析。
 * 返回结构为嵌套数组，译文分散在 data[0][i][0]。
 */
async function translateText(text, sl, tl) {
  const url =
    "https://translate.googleapis.com/translate_a/single?client=gtx" +
    `&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text)}`;

  const response = await dasktop.net.request({ url, method: "GET" });

  if (response.status !== 200) {
    throw new Error(`翻译服务返回 ${response.status}`);
  }

  const data = JSON.parse(response.body);

  return (data[0] || []).map((segment) => segment[0]).join("");
}

async function doTranslate() {
  if (busy) {
    return;
  }

  const text = source.value.trim();

  if (!text) {
    result.value = "";
    setStatus("");
    return;
  }

  const sl = srcLang.value;
  const tl = dstLang.value;

  // 源与目标同语言（非自动）直接回显，省一次网络往返。
  if (sl !== "auto" && sl === tl) {
    result.value = text;
    setStatus("源语言与目标语言相同", "ok");
    return;
  }

  busy = true;
  setStatus("翻译中…");

  try {
    result.value = await translateText(text, sl, tl);
    setStatus("翻译完成", "ok");
  } catch (error) {
    result.value = "";
    setStatus(error.message || "翻译失败", "error");
  } finally {
    busy = false;
  }
}

/**
 * 实时翻译的防抖入口：仅当「自动翻译」开关打开时随输入触发。
 */
let debounceTimer = null;

function scheduleTranslate() {
  if (!webToggle.checked) {
    return;
  }

  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(doTranslate, 400);
}

/* ------------------------------ 朗读 / 复制 ------------------------------ */

/**
 * 朗读文本。auto 源语言无法预知，回落到英文嗓音，避免直接喂 auto 导致静音。
 */
function speak(text, lang) {
  if (!text) {
    return;
  }

  if (!window.speechSynthesis) {
    setStatus("当前环境不支持朗读", "error");
    return;
  }

  speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang === "auto" ? "en" : lang;
  speechSynthesis.speak(utterance);
}

async function copyText(text) {
  if (!text) {
    return;
  }

  try {
    if (window.dasktop && dasktop.has("clipboard:write")) {
      await dasktop.clipboard.write(text);
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      throw new Error("当前环境不支持复制");
    }

    setStatus("已复制到剪贴板", "ok");
  } catch (error) {
    setStatus(error.message || "复制失败", "error");
  }
}

/* ------------------------------ 交换语言 ------------------------------ */

function swapLanguages() {
  const from = srcLang.value;

  srcLang.value = dstLang.value;
  dstLang.value = from;

  // 同时交换两侧文本，符合「互换语言重译」的预期。
  const temp = source.value;
  source.value = result.value;
  result.value = temp;

  if (webToggle.checked && source.value.trim()) {
    doTranslate();
  }
}

/* ------------------------------ 拖拽 ------------------------------ */

/**
 * 无边框浮层没有系统标题栏，顶栏在鼠标按下时发起系统拖动。
 * 必须在 mousedown 同步调用，OS 才会接管；左键且非双击才进入拖动。
 */
function handleDragStart(event) {
  if (event.button !== 0 || event.detail > 1) {
    return;
  }

  if (window.dasktop && dasktop.window) {
    dasktop.window.startDragging();
  }
}

/* ------------------------------ 状态提示 ------------------------------ */

function setStatus(text, kind) {
  statusBar.textContent = text;
  statusBar.className = `status ${kind || "muted"}`;
}

/* ------------------------------ 事件绑定 ------------------------------ */

function bindEvents() {
  translateBtn.addEventListener("click", doTranslate);
  swapBtn.addEventListener("click", swapLanguages);

  srcSpeak.addEventListener("click", () => speak(source.value, srcLang.value));
  dstSpeak.addEventListener("click", () => speak(result.value, dstLang.value));
  srcCopy.addEventListener("click", () => copyText(source.value));
  dstCopy.addEventListener("click", () => copyText(result.value));

  // 自动翻译开关：实时翻译模式。状态落库，开启且已有内容则立即译一次。
  webToggle.addEventListener("change", () => {
    localStorage.setItem("translator:web", webToggle.checked ? "1" : "0");

    if (webToggle.checked && source.value.trim()) {
      doTranslate();
    }
  });

  // 实时模式随输入自动翻译；非实时模式靠按钮或回车。
  source.addEventListener("input", scheduleTranslate);
  source.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      doTranslate();
    }
  });

  topbar.addEventListener("mousedown", handleDragStart);
}

/* ------------------------------ 启动 ------------------------------ */

function checkBridge() {
  if (!window.dasktop || !dasktop.has("net:request")) {
    setStatus(
      "宿主翻译能力不可用：请由 Dasktop 打开本插件，否则无法联网翻译。",
      "error",
    );
  }
}

fillLanguages();
restoreWebToggle();
bindEvents();
checkBridge();
