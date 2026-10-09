/**
 * HTTP 控制台 —— 演示 `net:request` 与声明式界面的最小可用插件。
 *
 * 这个插件刻意把三种能力都用上，作为框架的端到端样本：
 * - `net:request`：真的发出一次 HTTP 请求；
 * - `ui:panel`：用纯数据描述界面，宿主负责渲染成真实 DOM；
 * - `fs:read` / `fs:write`：把请求历史持久化在插件包目录内的 `state.json`。
 *
 * 注意本文件运行在 **Web Worker** 里：没有 `window`、没有 `document`、没有 Tauri 注入对象。
 * 所有副作用都必须通过 `host` 提供的受控方法请求宿主代为执行。
 */

/** 状态文件名，位于插件包自身目录内（`fs` 沙箱的可见范围）。 */
const STATE_FILE = "state.json";

/** 默认请求地址，选一个无需鉴权、返回结构稳定的公开接口。 */
const DEFAULT_URL = "https://api.github.com/repos/tauri-apps/tauri";

/** 历史记录最多保留条数。 */
const HISTORY_LIMIT = 8;

/** 结果预览截断长度，避免长响应把界面撑爆。 */
const PREVIEW_LIMIT = 600;

/** 宿主注入的受控上下文，卸载时置空以便被回收。 */
let host = null;

/** 插件状态，持久化到 `state.json`。 */
let state = createInitialState();

/**
 * 宿主加载插件时调用。
 */
export async function activate(nextHost) {
  host = nextHost;

  // 先赋值 host 再读状态：loadState 依赖 host.fs。
  state = await loadState();

  await host.log?.info(`HTTP 控制台已激活（历史 ${state.history.length} 条）`);
  render();
}

/**
 * 宿主卸载插件时调用。
 */
export async function deactivate() {
  await saveState();
  await host?.log?.info("HTTP 控制台已卸载");

  host = null;
}

/**
 * 处理界面交互，由宿主在用户操作后调用。
 *
 * 这个导出是**可选的**：没有界面交互需求的插件可以不导出它。
 */
export async function onUiEvent(action, payload) {
  if (action === "setUrl") {
    // 只记录不重渲染：输入过程中重渲染会让输入框重建、光标位置丢失。
    state.url = String(payload ?? "");
    return;
  }

  if (action === "clear") {
    state.history = [];
    state.lastResult = null;
    await saveState();
    render();

    return;
  }

  if (action === "send") {
    await sendRequest();
  }
}

/**
 * 发出请求并把结果写进状态。
 */
async function sendRequest() {
  const url = state.url.trim();

  if (!host?.net) {
    // 插件自己声明了 net:request，正常不会走到这里；显式处理是为了演示
    // 「能力缺失时插件应给出可读提示」，而不是靠 try/catch 掩盖。
    state.lastResult = createFailure("当前授权里没有 net:request 权限");

    await host?.log?.error("缺少 net:request 权限，无法发送请求");
    render();

    return;
  }

  const startedAt = Date.now();
  await host.log?.info(`发送 ${url}`);

  try {
    const response = await host.net.request({ url });
    const elapsedMs = Date.now() - startedAt;

    state.lastResult = {
      elapsedMs,
      ok: true,
      preview: summarize(response.body),
      status: response.status,
      url,
    };
    state.history = [{ status: response.status, url }, ...state.history].slice(0, HISTORY_LIMIT);

    await host.log?.info(`${response.status} ${url}（${elapsedMs}ms）`);
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;

    state.lastResult = {
      elapsedMs,
      ok: false,
      preview: describeError(error),
      status: 0,
      url,
    };

    await host.log?.error(`请求失败：${url}（${describeError(error)}）`);
  }

  await saveState();
  render();
}

/**
 * 下发一次界面描述。
 *
 * 全部是普通对象与字符串：宿主渲染器只认识协议里列出的节点类型，
 * 插件无法借界面把任意 HTML 送进宿主。
 */
function render() {
  host?.ui?.render({
    children: [
      {
        tone: "muted",
        type: "text",
        value: "输入地址后发送一次 GET 请求，结果与历史会立刻显示在这里。",
      },
      {
        action: "setUrl",
        label: "请求地址",
        placeholder: "https://",
        type: "input",
        value: state.url,
      },
      {
        children: [
          { action: "send", label: "发送请求", tone: "primary", type: "button" },
          { action: "clear", label: "清空历史", type: "button" },
        ],
        direction: "row",
        gap: "sm",
        type: "stack",
      },
      createResultCard(),
      createHistoryCard(),
    ],
    direction: "column",
    gap: "md",
    type: "stack",
  });
}

/**
 * 最近一次请求的结果卡片。
 */
function createResultCard() {
  if (!state.lastResult) {
    return {
      children: [{ tone: "muted", type: "text", value: "尚未发送请求。" }],
      title: "最近一次结果",
      type: "card",
    };
  }

  const { elapsedMs, ok, preview, status, url } = state.lastResult;

  return {
    children: [
      {
        entries: [
          { key: "状态", value: ok ? String(status) : "请求失败" },
          { key: "耗时", value: `${elapsedMs} ms` },
          { key: "地址", value: url },
        ],
        type: "key-value",
      },
      { tone: "muted", type: "text", value: preview },
    ],
    title: "最近一次结果",
    type: "card",
  };
}

/**
 * 请求历史卡片。
 */
function createHistoryCard() {
  if (state.history.length === 0) {
    return {
      children: [{ tone: "muted", type: "text", value: "还没有历史记录。" }],
      title: "历史",
      type: "card",
    };
  }

  return {
    children: [
      {
        items: state.history.map((entry) => `${entry.status} · ${entry.url}`),
        type: "list",
      },
    ],
    title: `历史（${state.history.length}）`,
    type: "card",
  };
}

/**
 * 读取持久化状态。
 *
 * 状态文件损坏或不存在时一律回退到初始状态：插件不应该因为一份写坏的状态而永久无法激活。
 */
async function loadState() {
  if (!host?.fs?.read) {
    return createInitialState();
  }

  try {
    const raw = await host.fs.read(STATE_FILE);
    const parsed = JSON.parse(raw);

    return {
      history: Array.isArray(parsed.history) ? parsed.history : [],
      lastResult: parsed.lastResult ?? null,
      url: typeof parsed.url === "string" && parsed.url ? parsed.url : DEFAULT_URL,
    };
  } catch {
    return createInitialState();
  }
}

/**
 * 写出持久化状态。
 */
async function saveState() {
  if (!host?.fs?.write) {
    return;
  }

  try {
    await host.fs.write(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    await host.log?.error(`保存状态失败：${describeError(error)}`);
  }
}

/**
 * 初始状态。
 */
function createInitialState() {
  return { history: [], lastResult: null, url: DEFAULT_URL };
}

/**
 * 构造一条「请求未发出」的结果记录。
 */
function createFailure(message) {
  return { elapsedMs: 0, ok: false, preview: message, status: 0, url: state.url.trim() };
}

/**
 * 截断响应体，保留开头足够判断内容的片段。
 */
function summarize(body) {
  const text = typeof body === "string" ? body : "";

  if (text.length <= PREVIEW_LIMIT) {
    return text || "（响应体为空）";
  }

  return `${text.slice(0, PREVIEW_LIMIT)}…（共 ${text.length} 字符）`;
}

/**
 * 把任意异常收敛成可读字符串。
 */
function describeError(error) {
  if (error && typeof error.message === "string") {
    return error.message;
  }

  return String(error);
}
