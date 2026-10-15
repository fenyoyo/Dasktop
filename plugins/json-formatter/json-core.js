/*
 * JSON 解析与加工核心，与界面完全解耦（不碰 DOM），方便被任何页面复用。
 *
 * 这里有两块值得说明的设计：
 *
 * 1. 解析管线。粘贴进来的文本经常不是「干净」的 JSON——可能是 URL 编码过的、
 *    整体被 \uXXXX 转义过的、包了一层 JSONP 回调的，或者被 JSON.stringify 了
 *    好几次的字符串。管线按「URL 解码 → Unicode 解码 → JSONP 提取 → 多层转义
 *    剥离」的顺序逐个尝试，每成功一步记录下来，让用户知道文本被改动过。
 *
 * 2. 手写校验扫描器。现代 V8（WebView2 用的就是）的 JSON.parse 报错信息已经
 *    不再携带 position，只有「... is not valid JSON」。所以定位错误行列只能靠
 *    自己扫：parse 失败时再跑一遍递归下降扫描器，拿到精确的出错偏移量。
 *    扫描器只在失败路径上执行，正常解析仍然是原生 JSON.parse，性能不受影响。
 */

/** 多层转义最多剥开的层数，防御恶意构造的无限嵌套字符串把页面卡死。 */
const MAX_UNWRAP_DEPTH = 5;

/** JSONP 回调名允许的字符：标识符、点与下标，覆盖 `callback(...)`、`a.b[0](...)` 这类写法。 */
const JSONP_PATTERN = /^[\w$.[\]]+\s*\(\s*([\s\S]*?)\s*\)\s*;?\s*$/;

/**
 * 解析管线：把一段「可能不干净的」文本解析成 JSON 值。
 *
 * @param {string} raw 用户粘贴的原始文本
 * @returns {{ ok: true, value: unknown, steps: string[] } | { ok: false, message: string, line: number, column: number }}
 *   成功时 `steps` 记录应用过的自动转换；失败时给出中文原因与 1 起始的行列号。
 */
export function parsePipeline(raw) {
  const steps = [];
  let text = raw.trim();
  let result = tryParse(text);

  if (!result.ok && /%[0-9A-Fa-f]{2}/.test(text)) {
    // 形如 %7B%22a%22%3A1%7D 的整体 URL 编码。decodeURIComponent 对非法序列会抛错，兜住即可。
    try {
      const decoded = decodeURIComponent(text);
      const attempt = tryParse(decoded);
      if (attempt.ok) {
        text = decoded;
        result = attempt;
        steps.push("URL 解码");
      }
    } catch {
      // 编码不完整（如结尾是孤立 %），按未解码继续尝试后面的转换。
    }
  }

  if (!result.ok && /\\u[0-9A-Fa-f]{4}/.test(text)) {
    // 形如 \u007b\u0022a\u0022:1\u007d 的整体 Unicode 转义：JSON.parse 只会转义
    // 字符串内部的 \uXXXX，文本本身被整体转义时需要先手动还原。
    const decoded = text.replace(/\\u([0-9A-Fa-f]{4})/g, (_, hex) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
    const attempt = tryParse(decoded);
    if (attempt.ok) {
      text = decoded;
      result = attempt;
      steps.push("Unicode 解码");
    }
  }

  if (!result.ok) {
    const jsonp = text.match(JSONP_PATTERN);
    if (jsonp) {
      const attempt = tryParse(jsonp[1]);
      if (attempt.ok) {
        text = jsonp[1];
        result = attempt;
        steps.push("JSONP 提取");
      }
    }
  }

  // 多层转义：{"a":"{\"b\":1}"} 这类数据，parse 出来的值仍是 JSON 字符串，继续剥。
  // 每一层都要求「确实是字符串且剥得动」，剥不动就停，不会误伤普通字符串值。
  let unwrapped = 0;
  while (result.ok && typeof result.value === "string" && unwrapped < MAX_UNWRAP_DEPTH) {
    const inner = result.value.trim();
    if (!inner.startsWith("{") && !inner.startsWith("[")) {
      break;
    }
    const attempt = tryParse(inner);
    if (!attempt.ok) {
      break;
    }
    result = attempt;
    unwrapped += 1;
  }
  if (unwrapped > 0) {
    steps.push(`剥离 ${unwrapped + 1} 层转义`);
  }

  if (result.ok) {
    return { ok: true, value: result.value, steps };
  }

  // parse 失败时上扫描器拿精确位置；扫描器自己也有出错信息（比引擎的更具体）。
  const located = locateError(text);
  return { ok: false, message: located.message, line: located.line, column: located.column };
}

/**
 * 递归地对对象的键排序；数组保持元素顺序，只对数组里的对象成员排序。
 *
 * @param {unknown} value 已解析的 JSON 值
 * @param {"none" | "asc" | "desc"} order 排序方式
 */
export function sortKeysDeep(value, order) {
  if (order === "none" || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sortKeysDeep(item, order));
  }

  const keys = Object.keys(value);
  keys.sort();
  if (order === "desc") {
    keys.reverse();
  }

  const sorted = {};
  for (const key of keys) {
    sorted[key] = sortKeysDeep(value[key], order);
  }
  return sorted;
}

/**
 * 序列化为格式化文本（2 空格缩进）或压缩文本（无多余空白）。
 *
 * @param {unknown} value
 * @param {"pretty" | "minified"} mode
 */
export function serialize(value, mode) {
  return mode === "pretty" ? JSON.stringify(value, null, 2) : JSON.stringify(value);
}

function tryParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/* -------------------------------------------------------------------------- */
/* 手写校验扫描器：只在 JSON.parse 失败后运行，负责给出精确的错误位置            */
/* -------------------------------------------------------------------------- */

/** 扫描器抛出的错误，携带出错点在原文中的字符偏移。 */
class ScanError extends Error {
  constructor(message, index) {
    super(message);
    this.index = index;
  }
}

/**
 * 在一段 JSON.parse 失败的文本里找出第一个语法错误的位置。
 *
 * @param {string} text 已做过去噪处理（解码/提取之后）的文本
 * @returns {{ message: string, line: number, column: number }}
 */
function locateError(text) {
  try {
    scan(text);
    // 理论上不会走到这里：parse 失败而扫描器通过，说明两者语义有出入，
    // 兜底报一个通用信息，行列指向全文末尾。
    return { message: "无法识别的 JSON 内容", ...lineColumnOf(text, text.length) };
  } catch (error) {
    if (error instanceof ScanError) {
      return { message: error.message, ...lineColumnOf(text, error.index) };
    }
    throw error;
  }
}

/** 把字符偏移换算成 1 起始的行列号。 */
function lineColumnOf(text, index) {
  let line = 1;
  let column = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const HEX = /^[0-9A-Fa-f]$/;

/**
 * 递归下降扫描一遍全文，遇到第一个语法错误就抛 ScanError。
 * 只校验不产出值——值仍然由原生 JSON.parse 给出。
 */
function scan(text) {
  let i = 0;
  const length = text.length;

  const skipWhitespace = () => {
    while (i < length && WHITESPACE.has(text[i])) {
      i += 1;
    }
  };

  const fail = (message, index = i) => {
    throw new ScanError(message, index);
  };

  const scanString = () => {
    // 进入时 text[i] 是开引号。
    i += 1;
    while (i < length) {
      const char = text[i];
      if (char === '"') {
        i += 1;
        return;
      }
      if (char === "\\") {
        i += 1;
        if (i >= length) {
          break;
        }
        const escape = text[i];
        if ('"\\/bfnrt'.includes(escape)) {
          i += 1;
          continue;
        }
        if (escape === "u") {
          for (let offset = 1; offset <= 4; offset += 1) {
            if (i + offset >= length || !HEX.test(text[i + offset])) {
              fail("\\u 转义后必须跟 4 位十六进制字符", i);
            }
          }
          i += 5;
          continue;
        }
        fail(`无法识别的转义序列 \\${escape}`, i - 1);
      }
      if (char < " ") {
        fail("字符串中含未转义的控制字符", i);
      }
      i += 1;
    }
    fail("字符串缺少结束引号", length);
  };

  const scanNumber = () => {
    const start = i;
    if (text[i] === "-") {
      i += 1;
    }
    if (i >= length || !/\d/.test(text[i])) {
      fail("数字格式不正确", start);
    }
    if (text[i] === "0") {
      i += 1;
    } else {
      while (i < length && /\d/.test(text[i])) {
        i += 1;
      }
    }
    if (text[i] === ".") {
      i += 1;
      if (i >= length || !/\d/.test(text[i])) {
        fail("小数点后必须有数字", i);
      }
      while (i < length && /\d/.test(text[i])) {
        i += 1;
      }
    }
    if (text[i] === "e" || text[i] === "E") {
      i += 1;
      if (text[i] === "+" || text[i] === "-") {
        i += 1;
      }
      if (i >= length || !/\d/.test(text[i])) {
        fail("指数部分必须有数字", i);
      }
      while (i < length && /\d/.test(text[i])) {
        i += 1;
      }
    }
  };

  const scanLiteral = (literal) => {
    if (text.startsWith(literal, i)) {
      i += literal.length;
      return;
    }
    fail(`无法识别的内容（期望 ${literal}）`, i);
  };

  const scanValue = () => {
    skipWhitespace();
    if (i >= length) {
      fail("输入意外结束，期望一个值", i);
    }
    const char = text[i];
    if (char === "{") {
      scanObject();
    } else if (char === "[") {
      scanArray();
    } else if (char === '"') {
      scanString();
    } else if (char === "-" || /\d/.test(char)) {
      scanNumber();
    } else if (char === "t") {
      scanLiteral("true");
    } else if (char === "f") {
      scanLiteral("false");
    } else if (char === "n") {
      scanLiteral("null");
    } else {
      fail(`无法识别的字符「${char}」`, i);
    }
  };

  const scanObject = () => {
    // 进入时 text[i] 是 '{'。
    i += 1;
    skipWhitespace();
    if (text[i] === "}") {
      i += 1;
      return;
    }
    for (;;) {
      skipWhitespace();
      if (i >= length) {
        fail("输入意外结束，对象缺少 }", i);
      }
      if (text[i] !== '"') {
        fail(text[i] === "}" ? "对象末尾多余的逗号" : "对象的键必须是字符串", i);
      }
      scanString();
      skipWhitespace();
      if (text[i] !== ":") {
        fail("键之后期望冒号", i);
      }
      i += 1;
      scanValue();
      skipWhitespace();
      if (text[i] === ",") {
        i += 1;
        continue;
      }
      if (text[i] === "}") {
        i += 1;
        return;
      }
      fail(i >= length ? "输入意外结束，对象缺少 }" : `期望逗号或 }，却遇到「${text[i]}」`, i);
    }
  };

  const scanArray = () => {
    // 进入时 text[i] 是 '['。
    i += 1;
    skipWhitespace();
    if (text[i] === "]") {
      i += 1;
      return;
    }
    for (;;) {
      scanValue();
      skipWhitespace();
      if (i >= length) {
        fail("输入意外结束，数组缺少 ]", i);
      }
      if (text[i] === ",") {
        i += 1;
        skipWhitespace();
        if (text[i] === "]") {
          fail("数组末尾多余的逗号", i);
        }
        continue;
      }
      if (text[i] === "]") {
        i += 1;
        return;
      }
      fail(`期望逗号或 ]，却遇到「${text[i]}」`, i);
    }
  };

  scanValue();
  skipWhitespace();
  if (i < length) {
    fail(`JSON 结束后存在多余的内容「${text[i]}」`, i);
  }
}
