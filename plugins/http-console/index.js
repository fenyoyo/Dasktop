/*
 * 控制台首页的逻辑。
 *
 * 和页面里其它东西一样，这个文件由 index.html 用 <script type="module"> 引入，
 * 宿主不知道它存在。宿主只在页面脚本执行之前把能力桥挂到 `window.dasktop` 上。
 */

import { prependEntry } from "./state.js";

const DEFAULT_URL = "https://api.github.com/repos/tauri-apps/tauri";
const PREVIEW_LIMIT = 600;

const urlInput = document.getElementById("url");
const resultBox = document.getElementById("result");
const sendButton = document.getElementById("send");
const copyButton = document.getElementById("copy");

let lastBody = "";

urlInput.value = DEFAULT_URL;

sendButton.addEventListener("click", sendRequest);
urlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    sendRequest();
  }
});

copyButton.addEventListener("click", async () => {
  if (!lastBody) {
    return;
  }

  try {
    await dasktop.clipboard.write(lastBody);
    copyButton.textContent = "已复制";
    setTimeout(() => {
      copyButton.textContent = "复制响应";
    }, 1500);
  } catch (error) {
    copyButton.textContent = "复制失败";
    setTimeout(() => {
      copyButton.textContent = "复制响应";
    }, 1500);
  }
});

/*
 * `dasktop` 由宿主注入，直接用浏览器打开这个 HTML 时它不存在。禁用按钮而不是在
 * 事件里逐处判断：逻辑主体可以保持「桥一定在」的写法，读起来干净。
 */
if (window.dasktop) {
  void restoreLastResult();
} else {
  sendButton.disabled = true;
  renderHint("宿主能力桥不可用：这个页面不是由 Dasktop 打开的。");
}

async function sendRequest() {
  const url = urlInput.value.trim();

  if (!url) {
    return;
  }

  sendButton.disabled = true;
  renderHint(`正在请求 ${url} …`);

  const startedAt = performance.now();

  try {
    /*
     * 用宿主的能力发请求，而不是页面的 `fetch`：请求由宿主进程发出，不受同源策略约束，
     * 目标接口不必返回 `Access-Control-Allow-Origin`，插件也就能访问正常情况下拿不到
     * 的接口。代价是它必须在 plugin.json 里声明 net:request。
     */
    const response = await dasktop.net.request({ url });
    const elapsedMs = Math.round(performance.now() - startedAt);

    renderResult({ body: response.body, elapsedMs, ok: true, status: response.status, url });
    await log("info", `GET ${url} -> ${response.status}（${elapsedMs} ms）`);
    await remember({ status: response.status, url });
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    const elapsedMs = Math.round(performance.now() - startedAt);

    renderResult({ body: message, elapsedMs, ok: false, status: 0, url });
    await log("error", `GET ${url} 失败：${message}`);
    await remember({ status: 0, url });
  } finally {
    sendButton.disabled = false;
  }
}

/*
 * 日志写不进去不该影响主流程，所以单独兜住异常：少了这层，一次写日志失败会被上面的
 * catch 当成「请求失败」显示出来，把真正的原因盖掉。
 */
async function log(level, message) {
  try {
    await dasktop.log.write(level, message);
  } catch {
    return;
  }
}

async function remember(entry) {
  try {
    await prependEntry(entry);
  } catch (error) {
    await log("error", `历史写入失败：${error && error.message ? error.message : error}`);
  }
}

async function restoreLastResult() {
  try {
    const parsed = JSON.parse(await dasktop.fs.read("state.json"));
    const last = Array.isArray(parsed.entries) ? parsed.entries[0] : undefined;

    if (last) {
      renderHint(`上次请求：${last.url}（${last.status === 0 ? "失败" : last.status}）`);
    }
  } catch {
    // 没有历史是常态，不必提示。
  }
}

function renderHint(text) {
  resultBox.innerHTML = "";

  const span = document.createElement("span");
  span.className = "muted";
  span.textContent = text;

  resultBox.appendChild(span);
}

function renderResult({ body, elapsedMs, ok, status, url }) {
  const preview = body.length > PREVIEW_LIMIT ? `${body.slice(0, PREVIEW_LIMIT)}…（共 ${body.length} 字符）` : body;

  lastBody = body;
  copyButton.style.display = body ? "" : "none";
  copyButton.textContent = "复制响应";

  resultBox.innerHTML = "";
  resultBox.appendChild(
    fieldList([
      ["状态", ok ? String(status) : "请求失败"],
      ["耗时", `${elapsedMs} ms`],
      ["地址", url],
    ]),
  );

  const block = document.createElement("pre");
  block.textContent = preview || "（响应体为空）";
  resultBox.appendChild(block);
}

function fieldList(entries) {
  const list = document.createElement("dl");

  for (const [key, value] of entries) {
    const term = document.createElement("dt");
    term.textContent = key;
    const detail = document.createElement("dd");
    detail.textContent = value;

    list.append(term, detail);
  }

  return list;
}
