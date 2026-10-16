/*
 * 界面编排：工具栏事件、解析管线接线、主题与布局偏好。
 *
 * 数据处理全部在 json-core.js、渲染全部在 tree-view.js，这个文件只做
 * 「把用户的操作接到管线上，把管线的结果贴到界面上」这一件事。
 */

import { parsePipeline, serialize, sortKeysDeep } from "./json-core.js";
import { renderTree } from "./tree-view.js";

/*
 * 所有插件共享同一个 origin，localStorage 是公用的，key 必须带插件名前缀，
 * 否则会和其它插件互相覆盖（见插件包框架文档）。
 */
const STORAGE_KEYS = { layout: "json-formatter:layout", theme: "json-formatter:theme" };

const input = document.getElementById("input");
const inputStat = document.getElementById("input-stat");
const gutter = document.getElementById("gutter");
const output = document.getElementById("output");
const statusBar = document.getElementById("status");
const panes = document.getElementById("panes");

const formatButton = document.getElementById("format");
const minifyButton = document.getElementById("minify");
const copyButton = document.getElementById("copy");
const pasteButton = document.getElementById("paste");
const sortSelect = document.getElementById("sort");
const themeSelect = document.getElementById("theme");
const layoutButton = document.getElementById("layout");
const expandAllButton = document.getElementById("expand-all");
const collapseAllButton = document.getElementById("collapse-all");

/*
 * 最近一次成功解析并加工后的值，是复制与重新排序的数据源。
 * 输入区内容变了它不算数——只有经过管线加工的值才允许被复制，
 * 否则「复制结果」复制的可能是和屏幕上对不上的东西。
 */
let currentValue;
let currentMode = "pretty";
let treeControls = null;

formatButton.addEventListener("click", () => applyPipeline("pretty"));
minifyButton.addEventListener("click", () => applyPipeline("minified"));

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    applyPipeline("pretty");
  }
});

input.addEventListener("input", () => {
  inputStat.textContent = `${input.value.length.toLocaleString()} 字符`;
  renderGutter();
});

// 行号列自身不滚动，位置完全跟随输入区的滚动条；水平滚动不影响行号，无需同步 scrollLeft。
input.addEventListener("scroll", () => {
  gutter.scrollTop = input.scrollTop;
});

/**
 * 重建行号列。
 *
 * 行号按换行符数出来，而不是按视觉行：输入区用 wrap="off" 关掉了自动换行，
 * 一个逻辑行就是一行，两者才能对上。空输入按 1 行算，与常见编辑器一致——
 * 光标停在第 1 行，左侧就该显示 1。
 */
function renderGutter() {
  const lineCount = input.value.split("\n").length;
  const numbers = [];
  for (let line = 1; line <= lineCount; line++) {
    numbers.push(String(line));
  }

  gutter.textContent = numbers.join("\n");
  gutter.scrollTop = input.scrollTop;
}

// 排序不是独立的显示开关，而是管线的一环：改动排序后需要重新加工当前输入。
sortSelect.addEventListener("change", () => {
  if (input.value.trim() !== "") {
    applyPipeline(currentMode);
  }
});

copyButton.addEventListener("click", async () => {
  if (currentValue === undefined) {
    setStatus("没有可复制的内容：请先格式化一段 JSON。", "error");
    return;
  }

  try {
    await dasktop.clipboard.write(serialize(currentValue, currentMode));
    flashButton(copyButton, "已复制");
  } catch (error) {
    setStatus(`复制失败：${error && error.message ? error.message : error}`, "error");
  }
});

pasteButton.addEventListener("click", () => loadFromClipboard({ silent: false }));

/**
 * 把剪贴板里的文本载入输入区并跑一遍格式化管线。
 *
 * 除了「粘贴剪贴板」按钮，插件窗口打开时也会静默调用一次：用户多半是先复制了一段
 * JSON 才想起打开这个工具，启动即载入能省掉一次粘贴动作。
 *
 * @param {{ silent: boolean }} options silent 为 true 时，剪贴板为空、内容不是 JSON、
 *   读取失败都**不打扰用户**——这些情况在「打开工具」这个场景里全都正常（用户打开
 *   工具前剪贴板里放着什么内容，与这个工具无关），报错只会让人以为工具坏了；
 *   用户主动点「粘贴剪贴板」时才把失败原因说出来。
 * @returns {Promise<void>}
 */
async function loadFromClipboard({ silent }) {
  let text;
  try {
    text = await dasktop.clipboard.read();
  } catch (error) {
    if (!silent) {
      setStatus(`读取剪贴板失败：${error && error.message ? error.message : error}`, "error");
    }
    return;
  }

  if (!text || text.trim() === "") {
    if (!silent) {
      setStatus("剪贴板里没有文本内容。", "error");
    }
    return;
  }

  /*
   * 「是不是 JSON」交给管线判断，不在外面再写一套正则。管线认得 URL 编码、整体
   * \uXXXX 转义、JSONP 这些变体，自己另判一套迟早会与它不一致，表现为「手动点粘贴
   * 能解析，启动时自动载入却无动于衷」这种自相矛盾的行为。
   */
  if (!parsePipeline(text).ok) {
    if (!silent) {
      setStatus("剪贴板内容不是 JSON。", "error");
    }
    return;
  }

  input.value = text;
  input.dispatchEvent(new Event("input"));
  applyPipeline("pretty", silent ? "已从剪贴板载入：" : "");
}

expandAllButton.addEventListener("click", () => {
  if (treeControls) {
    treeControls.expandAll();
  }
});

collapseAllButton.addEventListener("click", () => {
  if (treeControls) {
    treeControls.collapseAll();
  }
});

/* ------------------------------ 主题与布局 ------------------------------ */

themeSelect.addEventListener("change", () => {
  applyTheme(themeSelect.value);
  localStorage.setItem(STORAGE_KEYS.theme, themeSelect.value);
});

layoutButton.addEventListener("click", () => {
  const vertical = !panes.classList.contains("split-vertical");
  applyLayout(vertical);
  localStorage.setItem(STORAGE_KEYS.layout, vertical ? "vertical" : "horizontal");
});

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeSelect.value = theme;
}

function applyLayout(vertical) {
  panes.classList.toggle("split-vertical", vertical);
  panes.classList.toggle("split-horizontal", !vertical);
  layoutButton.textContent = vertical ? "⇅ 左右分栏" : "⇄ 上下分栏";
}

applyTheme(localStorage.getItem(STORAGE_KEYS.theme) ?? "auto");
applyLayout(localStorage.getItem(STORAGE_KEYS.layout) === "vertical");

/* ------------------------------ 管线接线 ------------------------------ */

/**
 * 把输入区原文跑一遍「解析 → 排序 → 渲染」的完整管线。
 *
 * @param {"pretty" | "minified"} mode pretty 渲染成可折叠树，minified 渲染成单行文本
 * @param {string} [prefix] 成功状态的前缀，用于标注这次加工的来源（如启动时自动载入）
 */
function applyPipeline(mode, prefix = "") {
  const raw = input.value;
  if (raw.trim() === "") {
    setStatus("输入为空：请先粘贴一段 JSON。", "error");
    return;
  }

  const result = parsePipeline(raw);
  if (!result.ok) {
    currentValue = undefined;
    treeControls = null;
    output.innerHTML = "";
    output.classList.remove("minified");
    const hint = document.createElement("span");
    hint.className = "muted";
    hint.textContent = "解析失败，输出为空。";
    output.appendChild(hint);
    setStatus(`第 ${result.line} 行第 ${result.column} 列：${result.message}`, "error");
    return;
  }

  currentValue = sortKeysDeep(result.value, sortSelect.value);
  currentMode = mode;

  if (mode === "pretty") {
    output.classList.remove("minified");
    treeControls = renderTree(currentValue, output);
  } else {
    treeControls = null;
    output.classList.add("minified");
    output.textContent = serialize(currentValue, "minified");
  }

  const transforms = result.steps.length > 0 ? `，已自动：${result.steps.join("、")}` : "";
  setStatus(`${prefix}JSON 有效${transforms}。`, "ok");
}

function setStatus(text, kind) {
  statusBar.textContent = text;
  statusBar.className = `status ${kind}`;
}

/** 短暂地把按钮文案换成反馈语，替代弹窗式提示。 */
function flashButton(button, text) {
  const original = button.textContent;
  button.textContent = text;
  setTimeout(() => {
    button.textContent = original;
  }, 1500);
}

/*
 * 桥只由宿主注入：直接用浏览器打开这个页面时 window.dasktop 不存在。
 * 剪贴板两个按钮依赖桥，没有桥就禁用；格式化本身不依赖任何宿主能力，照常可用。
 */
if (!window.dasktop) {
  copyButton.disabled = true;
  pasteButton.disabled = true;
  copyButton.title = "宿主能力桥不可用";
  pasteButton.title = "宿主能力桥不可用";
}

/*
 * 先渲染一次初始行号：空输入也要显示「1」，否则打开工具时左侧一片空白，
 * 而光标就停在第一行，看起来像是行号列没生效。
 */
renderGutter();

/*
 * 启动时自动读一次剪贴板，放最后执行：前面的主题、布局偏好与桥检测都已各就各位，
 * 界面先渲染成最终状态，再补一次「有没有现成 JSON 可以载入」的尝试。
 *
 * 只在输入区为空时载入——页面刚加载时输入区必然是空的，这条判断是为了防住未来
 * 有人把内容预置进输入区（或在同一页面里再次触发）时被静默覆盖。
 */
if (window.dasktop && dasktop.clipboard && input.value.trim() === "") {
  loadFromClipboard({ silent: true });
}
