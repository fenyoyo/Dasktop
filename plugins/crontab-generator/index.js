/*
 * Crontab 生成器界面逻辑。
 *
 * 负责字段编辑器渲染、生成/解析双模式切换、剪贴板复制与主题持久化。
 * 所有 cron 语义计算委托给 cron-core.js。
 */

import { describeExpression, getNextExecutions, parseExpression, serializeExpression } from "./cron-core.js";

/**
 * localStorage key 必须带插件名前缀，避免与其它插件冲突。
 */
const STORAGE_KEYS = {
  theme: "crontab-generator:theme",
};

/**
 * 每个时间字段在界面上的配置：中文名、最小值、最大值。
 */
const FIELD_CONFIG = [
  { key: "minute", label: "分", min: 0, max: 59 },
  { key: "hour", label: "时", min: 0, max: 23 },
  { key: "day", label: "日", min: 1, max: 31 },
  { key: "month", label: "月", min: 1, max: 12 },
  { key: "weekday", label: "星期", min: 0, max: 7 },
];

/**
 * 字段编辑器的类型选项。
 */
const FIELD_TYPES = [
  { value: "every", label: "任意" },
  { value: "step", label: "每隔" },
  { value: "range", label: "范围" },
  { value: "list", label: "指定" },
  { value: "single", label: "固定" },
];

/**
 * 当前五个字段的编辑状态。
 */
const fieldState = {
  minute: { type: "every", step: 5, rangeStart: 0, rangeEnd: 59, list: "0,15,30,45", single: 0 },
  hour: { type: "every", step: 1, rangeStart: 0, rangeEnd: 23, list: "9,12,18", single: 0 },
  day: { type: "every", step: 1, rangeStart: 1, rangeEnd: 31, list: "1,15", single: 1 },
  month: { type: "every", step: 1, rangeStart: 1, rangeEnd: 12, list: "1,6,12", single: 1 },
  weekday: { type: "every", step: 1, rangeStart: 1, rangeEnd: 5, list: "1,3,5", single: 1 },
};

const fieldsContainer = document.getElementById("fields");
const generateExpression = document.getElementById("generate-expression");
const generateDescription = document.getElementById("generate-description");
const generateNextRuns = document.getElementById("generate-next-runs");
const generateCopy = document.getElementById("generate-copy");

const tabGenerate = document.getElementById("tab-generate");
const tabParse = document.getElementById("tab-parse");
const panelGenerate = document.getElementById("panel-generate");
const panelParse = document.getElementById("panel-parse");
const themeSelect = document.getElementById("theme");
const statusBar = document.getElementById("status");

const parseInput = document.getElementById("parse-input");
const parseBtn = document.getElementById("parse-btn");
const parsePaste = document.getElementById("parse-paste");
const parseClear = document.getElementById("parse-clear");
const parseDescription = document.getElementById("parse-description");
const parseFields = document.getElementById("parse-fields");
const parseNextRuns = document.getElementById("parse-next-runs");

/* ------------------------------ 初始化 ------------------------------ */

function init() {
  renderFieldEditors();
  bindEvents();
  restoreTheme();
  updateGeneratedExpression();
  checkBridge();
}

/* ------------------------------ 字段编辑器 ------------------------------ */

/**
 * 渲染五个字段的编辑器。
 *
 * 每个字段包含：类型选择器 + 根据类型动态显示的值输入区。
 */
function renderFieldEditors() {
  fieldsContainer.innerHTML = "";

  for (const config of FIELD_CONFIG) {
    const card = document.createElement("div");
    card.className = "field-card";
    card.dataset.key = config.key;

    const header = document.createElement("div");
    header.className = "field-header";
    header.innerHTML = `<span class="field-name">${config.label}</span><span class="field-range">${config.min}-${config.max}</span>`;

    const controls = document.createElement("div");
    controls.className = "field-controls";

    const typeSelect = document.createElement("select");
    typeSelect.className = "field-type";
    typeSelect.dataset.key = config.key;
    typeSelect.dataset.role = "type";

    for (const type of FIELD_TYPES) {
      const option = document.createElement("option");
      option.value = type.value;
      option.textContent = type.label;
      typeSelect.appendChild(option);
    }

    typeSelect.value = fieldState[config.key].type;

    const valueContainer = document.createElement("div");
    valueContainer.className = "field-value";
    valueContainer.dataset.key = config.key;
    valueContainer.dataset.role = "value";

    controls.appendChild(typeSelect);
    controls.appendChild(valueContainer);
    card.appendChild(header);
    card.appendChild(controls);
    fieldsContainer.appendChild(card);

    renderValueInputs(config.key);
  }
}

/**
 * 根据当前字段类型渲染对应的值输入控件。
 *
 * @param {string} key 字段键名
 */
function renderValueInputs(key) {
  const config = FIELD_CONFIG.find((item) => item.key === key);
  const state = fieldState[key];
  const container = fieldsContainer.querySelector(`.field-value[data-key="${key}"]`);

  container.innerHTML = "";

  switch (state.type) {
    case "every":
      container.innerHTML = `<span class="muted">使用通配符 *</span>`;
      break;

    case "step":
      container.appendChild(createNumberInput(key, "step", state.step, 1, config.max - config.min + 1, "每 n 个单位"));
      break;

    case "range":
      container.appendChild(createNumberInput(key, "rangeStart", state.rangeStart, config.min, config.max, "起始"));
      container.appendChild(document.createTextNode(" - "));
      container.appendChild(createNumberInput(key, "rangeEnd", state.rangeEnd, config.min, config.max, "结束"));
      break;

    case "list":
      container.appendChild(createTextInput(key, "list", state.list, "逗号分隔，例如：1,3,5"));
      break;

    case "single":
      container.appendChild(createNumberInput(key, "single", state.single, config.min, config.max, "固定值"));
      break;
  }
}

/**
 * 创建一个数字输入框。
 */
function createNumberInput(key, field, value, min, max, placeholder) {
  const input = document.createElement("input");
  input.type = "number";
  input.min = min;
  input.max = max;
  input.value = value;
  input.placeholder = placeholder;
  input.dataset.key = key;
  input.dataset.field = field;

  return input;
}

/**
 * 创建一个文本输入框。
 */
function createTextInput(key, field, value, placeholder) {
  const input = document.createElement("input");
  input.type = "text";
  input.value = value;
  input.placeholder = placeholder;
  input.dataset.key = key;
  input.dataset.field = field;

  return input;
}

/**
 * 从字段状态生成单个 cron 字段字符串。
 *
 * @param {string} key 字段键名
 * @returns {string}
 */
function buildCronPart(key) {
  const state = fieldState[key];

  switch (state.type) {
    case "every":
      return "*";
    case "step":
      return `*/${state.step}`;
    case "range":
      return `${state.rangeStart}-${state.rangeEnd}`;
    case "list":
      return state.list.replace(/\s+/g, "");
    case "single":
      return String(state.single);
    default:
      return "*";
  }
}

/**
 * 把当前五个字段组合成完整表达式，并刷新描述与执行预览。
 */
function updateGeneratedExpression() {
  const parts = FIELD_CONFIG.map((config) => buildCronPart(config.key));
  const expression = parts.join(" ");

  generateExpression.value = expression;

  const description = describeExpression(expression);
  const runs = getNextExecutions(expression, 5);

  if (description.ok) {
    generateDescription.textContent = description.text;
    generateDescription.className = "description";
  } else {
    generateDescription.textContent = description.message || "";
    generateDescription.className = "description error";
  }

  renderNextRuns(generateNextRuns, runs);

  if (!runs.ok) {
    setStatus(runs.message || "表达式无效", "error");
  } else {
    setStatus("就绪。");
  }
}

/* ------------------------------ 解析面板 ------------------------------ */

/**
 * 解析输入框中的表达式并刷新结果区。
 */
function handleParse() {
  const expression = parseInput.value.trim();

  if (!expression) {
    setStatus("请输入 Cron 表达式", "error");
    return;
  }

  const parsed = parseExpression(expression);
  const description = describeExpression(expression);
  const runs = getNextExecutions(expression, 5);

  parseDescription.textContent = "";
  parseFields.innerHTML = "";
  parseNextRuns.innerHTML = "";

  if (!parsed.ok) {
    parseDescription.textContent = parsed.message || "解析失败";
    parseDescription.className = "description error";
    setStatus(parsed.message || "解析失败", "error");
    return;
  }

  parseDescription.className = "description";
  parseDescription.textContent = description.ok ? description.text : "";

  for (let index = 0; index < 5; index++) {
    const config = FIELD_CONFIG[index];
    const values = parsed.fields[index];
    const item = document.createElement("li");
    item.innerHTML = `<strong>${config.label}</strong>：${values.join(", ")}`;
    parseFields.appendChild(item);
  }

  renderNextRuns(parseNextRuns, runs);
  setStatus("解析完成", "ok");
}

/* ------------------------------ 通用 UI ------------------------------ */

/**
 * 渲染最近执行时间列表。
 *
 * @param {HTMLElement} container 列表容器
 * @param {{ ok: boolean, times?: Date[], message?: string }} result getNextExecutions 的结果
 */
function renderNextRuns(container, result) {
  container.innerHTML = "";

  if (!result.ok) {
    const item = document.createElement("li");
    item.className = "muted";
    item.textContent = result.message || "无法计算";
    container.appendChild(item);
    return;
  }

  if (result.times.length === 0) {
    const item = document.createElement("li");
    item.className = "muted";
    item.textContent = "未找到未来两年内的执行时间";
    container.appendChild(item);
    return;
  }

  for (const time of result.times) {
    const item = document.createElement("li");
    item.textContent = formatDateTime(time);
    container.appendChild(item);
  }
}

/**
 * 把 Date 格式化为本地化的日期时间字符串。
 *
 * @param {Date} date
 * @returns {string}
 */
function formatDateTime(date) {
  const pad = (value) => String(value).padStart(2, "0");

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function switchTab(tab) {
  const isGenerate = tab === "generate";

  tabGenerate.classList.toggle("active", isGenerate);
  tabParse.classList.toggle("active", !isGenerate);
  panelGenerate.classList.toggle("active", isGenerate);
  panelParse.classList.toggle("active", !isGenerate);

  if (isGenerate) {
    updateGeneratedExpression();
  }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeSelect.value = theme;
}

function restoreTheme() {
  applyTheme(localStorage.getItem(STORAGE_KEYS.theme) ?? "auto");
}

function setStatus(text, kind = "muted") {
  statusBar.textContent = text;
  statusBar.className = `status ${kind}`;
}

/**
 * 短暂地把按钮文案换成反馈语。
 *
 * @param {HTMLButtonElement} button
 * @param {string} text
 */
function flashButton(button, text) {
  const original = button.textContent;
  button.textContent = text;
  setTimeout(() => {
    button.textContent = original;
  }, 1500);
}

/**
 * 根据预设表达式反填字段编辑器。
 *
 * 预设都是常见模式，直接按五字段拆分后把每个字段设成最贴近的编辑类型。
 *
 * @param {string} expression 五字段 cron 表达式
 */
function applyPreset(expression) {
  const parsed = parseExpression(expression);

  if (!parsed.ok) {
    setStatus("预设表达式无效", "error");
    return;
  }

  for (let index = 0; index < 5; index++) {
    const key = FIELD_CONFIG[index].key;
    const values = parsed.fields[index];
    const state = inferStateFromValues(values, FIELD_CONFIG[index]);
    fieldState[key] = state;
  }

  renderFieldEditors();
  updateGeneratedExpression();
  setStatus("已应用预设");
}

/**
 * 根据字段允许值推断最合适的编辑类型与初始值。
 *
 * @param {number[]} values 字段允许值
 * @param {Object} config 字段配置
 * @returns {Object} 字段状态
 */
function inferStateFromValues(values, config) {
  const fullCount = config.max - config.min + 1;

  if (values.length === fullCount) {
    return { type: "every", step: 1, rangeStart: config.min, rangeEnd: config.max, list: values.join(","), single: config.min };
  }

  if (values.length === 1) {
    return { type: "single", step: 1, rangeStart: config.min, rangeEnd: config.max, list: values.join(","), single: values[0] };
  }

  const step = values[1] - values[0];
  const isStepFromMin = values[0] === config.min && values.every((value, index) => value === config.min + index * step);

  if (isStepFromMin) {
    return { type: "step", step, rangeStart: config.min, rangeEnd: config.max, list: values.join(","), single: config.min };
  }

  const isContinuous = values.every((value, index) => index === 0 || value === values[index - 1] + 1);

  if (isContinuous) {
    return { type: "range", step: 1, rangeStart: values[0], rangeEnd: values[values.length - 1], list: values.join(","), single: config.min };
  }

  return { type: "list", step: 1, rangeStart: config.min, rangeEnd: config.max, list: values.join(","), single: config.min };
}

/* ------------------------------ 事件绑定 ------------------------------ */

function bindEvents() {
  tabGenerate.addEventListener("click", () => switchTab("generate"));
  tabParse.addEventListener("click", () => switchTab("parse"));

  themeSelect.addEventListener("change", () => {
    applyTheme(themeSelect.value);
    localStorage.setItem(STORAGE_KEYS.theme, themeSelect.value);
  });

  // 字段编辑器：类型切换与值变化都走事件委托。
  fieldsContainer.addEventListener("change", (event) => {
    const target = event.target;

    if (target.dataset.role === "type") {
      const key = target.dataset.key;
      fieldState[key].type = target.value;
      renderValueInputs(key);
      updateGeneratedExpression();
    }
  });

  fieldsContainer.addEventListener("input", (event) => {
    const target = event.target;
    const key = target.dataset.key;
    const field = target.dataset.field;

    if (!key || !field) {
      return;
    }

    const state = fieldState[key];

    if (target.type === "number") {
      state[field] = Number(target.value);
    } else {
      state[field] = target.value;
    }

    updateGeneratedExpression();
  });

  // 快捷预设。
  for (const button of document.querySelectorAll(".preset")) {
    button.addEventListener("click", () => applyPreset(button.dataset.expression));
  }

  // 复制生成的表达式。
  generateCopy.addEventListener("click", async () => {
    const text = generateExpression.value;

    if (!text) {
      setStatus("没有可复制的内容", "error");
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

      flashButton(generateCopy, "已复制");
      setStatus("已复制到剪贴板", "ok");
    } catch (error) {
      setStatus(error.message || "复制失败", "error");
    }
  });

  // 解析面板。
  parseBtn.addEventListener("click", handleParse);
  parseInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleParse();
    }
  });

  parsePaste.addEventListener("click", async () => {
    try {
      let text = "";

      if (window.dasktop && dasktop.has("clipboard:read")) {
        text = await dasktop.clipboard.read();
      } else if (navigator.clipboard && navigator.clipboard.readText) {
        text = await navigator.clipboard.readText();
      } else {
        throw new Error("当前环境不支持粘贴");
      }

      parseInput.value = text.trim();
      handleParse();
    } catch (error) {
      setStatus(error.message || "粘贴失败", "error");
    }
  });

  parseClear.addEventListener("click", () => {
    parseInput.value = "";
    parseDescription.textContent = "";
    parseFields.innerHTML = "";
    parseNextRuns.innerHTML = "";
    setStatus("就绪。");
  });
}

/**
 * 没有宿主能力桥时，禁用依赖桥的按钮并给出提示。
 */
function checkBridge() {
  if (!window.dasktop) {
    setStatus("宿主能力桥不可用：复制/粘贴功能可能受限。");
    return;
  }

  if (!dasktop.has("clipboard:write")) {
    generateCopy.disabled = true;
  }

  if (!dasktop.has("clipboard:read")) {
    parsePaste.disabled = true;
  }
}

init();

