/*
 * Crontab 表达式核心逻辑。
 *
 * 提供解析、验证、人类可读描述与最近执行时间推算，不依赖 DOM，
 * 方便在插件页面与后续单元测试中复用。
 */

/**
 * 每个时间字段的元信息。
 *
 * @typedef {Object} FieldMeta
 * @property {string} name 字段中文名
 * @property {number} min 最小允许值
 * @property {number} max 最大允许值
 * @property {number} [alias] 等价别名（如星期里的 0 与 7）
 */

/** 标准五字段 cron 的元信息。 */
const FIELD_META = [
  { name: "分", min: 0, max: 59 },
  { name: "时", min: 0, max: 23 },
  { name: "日", min: 1, max: 31 },
  { name: "月", min: 1, max: 12 },
  { name: "星期", min: 0, max: 7, alias: 0 }, // 7 等价于 0
];

const WEEKDAY_NAMES = ["日", "一", "二", "三", "四", "五", "六", "日"];

/**
 * 把 cron 字段的原始字符串展开成允许值的有序集合。
 *
 * @param {string} raw 字段原始值，例如 *、1-5、星号/10、1,3,5
 * @param {FieldMeta} meta 字段元信息
 * @returns {{ ok: boolean, values?: number[], message?: string }}
 */
function expandField(raw, meta) {
  const tokens = raw.split(",").map((t) => t.trim()).filter(Boolean);

  if (tokens.length === 0) {
    return { ok: false, message: `${meta.name}字段不能为空` };
  }

  const result = new Set();

  for (const token of tokens) {
    const expand = expandToken(token, meta);

    if (!expand.ok) {
      return { ok: false, message: expand.message };
    }

    for (const value of expand.values) {
      result.add(value);
    }
  }

  const values = Array.from(result).sort((a, b) => a - b);

  if (meta.alias !== undefined && values.includes(meta.max)) {
    // 星期 0 与 7 都代表周日：保留两者，让 isEvery 判断与执行匹配都自然成立。
    const normalized = new Set(values);
    normalized.add(meta.alias);
    return { ok: true, values: Array.from(normalized).sort((a, b) => a - b) };
  }

  return { ok: true, values };
}

/**
 * 展开单个字段片段（不含逗号）。
 *
 * @param {string} token 例如 *、1-5、星号/10、5
 * @param {FieldMeta} meta 字段元信息
 * @returns {{ ok: boolean, values?: number[], message?: string }}
 */
function expandToken(token, meta) {
  const stepMatch = token.match(/^(.*)\/(\d+)$/);
  let step = 1;
  let rangePart = token;

  if (stepMatch) {
    rangePart = stepMatch[1];
    step = Number(stepMatch[2]);

    if (step < 1 || step > meta.max - meta.min + 1) {
      return { ok: false, message: `${meta.name}字段步长 ${step} 超出范围` };
    }
  }

  let start;
  let end;

  if (rangePart === "*") {
    start = meta.min;
    end = meta.max;
  } else if (rangePart.includes("-")) {
    const [rawStart, rawEnd] = rangePart.split("-");
    start = Number(rawStart);
    end = Number(rawEnd);

    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      return { ok: false, message: `${meta.name}字段范围必须是整数` };
    }
  } else {
    const value = Number(rangePart);

    if (!Number.isInteger(value)) {
      return { ok: false, message: `${meta.name}字段必须是整数` };
    }

    if (value < meta.min || value > meta.max) {
      return { ok: false, message: `${meta.name}字段值 ${value} 必须在 ${meta.min}-${meta.max} 之间` };
    }

    return { ok: true, values: [value] };
  }

  if (start < meta.min || end > meta.max || start > end) {
    return { ok: false, message: `${meta.name}字段范围 ${start}-${end} 无效` };
  }

  const values = [];

  for (let value = start; value <= end; value += step) {
    values.push(value);
  }

  return { ok: true, values };
}

/**
 * 解析完整的五字段 cron 表达式。
 *
 * @param {string} expression 形如 "0 0 * * *"
 * @returns {{ ok: boolean, fields?: number[][], message?: string }}
 */
export function parseExpression(expression) {
  const trimmed = expression.trim().replace(/\s+/g, " ");
  const parts = trimmed.split(" ");

  if (parts.length !== 5) {
    return { ok: false, message: "Crontab 表达式需要恰好 5 个字段（分 时 日 月 星期）" };
  }

  const fields = [];

  for (let index = 0; index < 5; index++) {
    const expanded = expandField(parts[index], FIELD_META[index]);

    if (!expanded.ok) {
      return { ok: false, message: expanded.message };
    }

    fields.push(expanded.values);
  }

  // 日期与星期同时为 * 是正常语义；同时为具体值在标准 crontab 里是「或」关系，这里允许。
  return { ok: true, fields };
}

/**
 * 把展开后的字段重新格式化成标准 cron 表达式。
 *
 * @param {number[][]} fields 五个字段的允许值数组
 * @returns {string}
 */
export function serializeExpression(fields) {
  return fields.map((values) => collapseValues(values)).join(" ");
}

/**
 * 把一组允许值折叠成最简 cron 字段字符串。
 *
 * 优先尝试连续的等差序列：如果整体是等差且覆盖整个范围，写成 "*" 或 "* /step"；
 * 否则回退到逗号分隔的具体值。
 *
 * @param {number[]} values 已排序的去重值数组
 * @returns {string}
 */
function collapseValues(values) {
  if (values.length === 0) {
    return "*";
  }

  const first = values[0];
  const last = values[values.length - 1];
  const step = values.length > 1 ? values[1] - values[0] : 1;
  const isArithmetic = values.every((value, index) => value === first + index * step);

  if (!isArithmetic) {
    return values.join(",");
  }

  const fullRange = last - first + 1;
  const meta = FIELD_META.find((m) => m.min <= first && m.max >= last) || { min: first, max: last };

  if (first === meta.min && last === meta.max) {
    return step === 1 ? "*" : `*/${step}`;
  }

  if (step === 1) {
    return `${first}-${last}`;
  }

  return `${first}-${last}/${step}`;
}

/**
 * 生成 cron 表达式的人类可读描述。
 *
 * 对常见模式做特判，给出更自然的中文说法；复杂表达式给出结构化描述。
 *
 * @param {string} expression 原始 cron 表达式
 * @returns {{ ok: boolean, text?: string, message?: string }}
 */
export function describeExpression(expression) {
  const parsed = parseExpression(expression);

  if (!parsed.ok) {
    return { ok: false, message: parsed.message };
  }

  const [minutes, hours, days, months, weekdays] = parsed.fields;
  const text = buildDescription(minutes, hours, days, months, weekdays);

  return { ok: true, text };
}

/**
 * 根据各字段的允许值构建中文描述。
 *
 * @param {number[]} minutes
 * @param {number[]} hours
 * @param {number[]} days
 * @param {number[]} months
 * @param {number[]} weekdays
 * @returns {string}
 */
function buildDescription(minutes, hours, days, months, weekdays) {
  const minuteText = describeMinute(minutes);
  const hourText = describeHour(hours);
  const dayText = describeDay(days);
  const monthText = describeMonth(months);
  const weekdayText = describeWeekday(weekdays);

  // 常见特判：每月 / 每周 / 每日 / 每小时
  if (isEvery(minutes, FIELD_META[0]) && isEvery(hours, FIELD_META[1]) && isEvery(days, FIELD_META[2]) && isEvery(months, FIELD_META[3]) && isEvery(weekdays, FIELD_META[4])) {
    return "每分钟执行一次";
  }

  if (isSingle(minutes) && isSingle(hours) && isEvery(days, FIELD_META[2]) && isEvery(months, FIELD_META[3]) && isEvery(weekdays, FIELD_META[4])) {
    return `每天 ${pad(hours[0])}:${pad(minutes[0])} 执行一次`;
  }

  if (isSingle(minutes) && isSingle(hours) && isEvery(days, FIELD_META[2]) && isEvery(months, FIELD_META[3]) && isSingle(weekdays)) {
    return `每周${WEEKDAY_NAMES[weekdays[0]]} ${pad(hours[0])}:${pad(minutes[0])} 执行一次`;
  }

  if (isSingle(minutes) && isSingle(hours) && isSingle(days) && isEvery(months, FIELD_META[3]) && isEvery(weekdays, FIELD_META[4])) {
    return `每月 ${days[0]} 日 ${pad(hours[0])}:${pad(minutes[0])} 执行一次`;
  }

  if (isSingle(minutes) && isSingle(hours) && isSingle(days) && isSingle(months) && isEvery(weekdays, FIELD_META[4])) {
    return `每年 ${months[0]} 月 ${days[0]} 日 ${pad(hours[0])}:${pad(minutes[0])} 执行一次`;
  }

  const parts = [minuteText, hourText, dayText, monthText, weekdayText].filter(Boolean);

  return `在${parts.join("，")}执行`;
}

function describeMinute(minutes) {
  if (isEvery(minutes, FIELD_META[0])) {
    return "每分钟";
  }

  if (isStepFrom(minutes, 0)) {
    return `每 ${minutes[1] - minutes[0]} 分钟`;
  }

  if (isSingle(minutes)) {
    return `第 ${pad(minutes[0])} 分`;
  }

  return `第 ${minutes.map(pad).join("、")} 分`;
}

function describeHour(hours) {
  if (isEvery(hours, FIELD_META[1])) {
    return "每小时";
  }

  if (isStepFrom(hours, 0)) {
    return `每 ${hours[1] - hours[0]} 小时`;
  }

  if (isSingle(hours)) {
    return `${pad(hours[0])} 时`;
  }

  return `${hours.map(pad).join("、")} 时`;
}

function describeDay(days) {
  if (isEvery(days, FIELD_META[2])) {
    return "每日";
  }

  if (isSingle(days)) {
    return `${days[0]} 日`;
  }

  return `${days.join("、")} 日`;
}

function describeMonth(months) {
  if (isEvery(months, FIELD_META[3])) {
    return "每月";
  }

  if (isSingle(months)) {
    return `${months[0]} 月`;
  }

  return `${months.join("、")} 月`;
}

function describeWeekday(weekdays) {
  if (isEvery(weekdays, FIELD_META[4])) {
    return "";
  }

  if (isSingle(weekdays)) {
    return `星期${WEEKDAY_NAMES[weekdays[0]]}`;
  }

  return `星期${weekdays.map((d) => WEEKDAY_NAMES[d]).join("、")}`;
}

function isEvery(values, meta) {
  return values.length === meta.max - meta.min + 1;
}
function isSingle(values) {
  return values.length === 1;
}

function isStepFrom(values, start) {
  if (values.length < 2 || values[0] !== start) {
    return false;
  }

  const step = values[1] - values[0];

  return values.every((value, index) => value === start + index * step);
}


function pad(value) {
  return String(value).padStart(2, "0");
}

/**
 * 计算从某时刻起的接下来若干次执行时间。
 *
 * 采用逐分钟推进的方式，简单可靠；cron 表达式的执行频率不会低于每分钟一次，
 * 因此逐分钟检查在性能上完全可接受。
 *
 * @param {string} expression cron 表达式
 * @param {number} count 需要返回的次数
 * @param {Date} [from] 起始时间，默认当前时间
 * @returns {{ ok: boolean, times?: Date[], message?: string }}
 */
export function getNextExecutions(expression, count, from = new Date()) {
  const parsed = parseExpression(expression);

  if (!parsed.ok) {
    return { ok: false, message: parsed.message };
  }

  const [minuteSet, hourSet, daySet, monthSet, weekdaySet] = parsed.fields.map((values) => new Set(values));
  const times = [];
  const cursor = new Date(from.getTime());

  // 从下一分钟开始查找，避免「当前这一秒」被算作一次执行。
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  // 安全边界：最多扫描两年，防止非法表达式导致死循环。
  const guard = new Date(cursor.getTime());
  guard.setFullYear(guard.getFullYear() + 2);

  while (times.length < count && cursor < guard) {
    if (
      minuteSet.has(cursor.getMinutes()) &&
      hourSet.has(cursor.getHours()) &&
      daySet.has(cursor.getDate()) &&
      monthSet.has(cursor.getMonth() + 1) &&
      weekdaySet.has(cursor.getDay())
    ) {
      times.push(new Date(cursor.getTime()));
    }

    cursor.setMinutes(cursor.getMinutes() + 1);
  }

  return { ok: true, times };
}

