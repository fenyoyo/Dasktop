/*
 * 第二个页面的逻辑。
 *
 * 页面间的跳转是一条普通的相对链接（见 history.html 顶部），宿主不参与：
 * 它只把入口页面加载起来，之后走哪儿由插件自己决定。所以两个页面天然共享同一套
 * 请求上下文（同一个 origin、同一份 localStorage），不需要谁来协调。
 */

import { readState, writeState } from "./state.js";

const list = document.getElementById("list");

if (window.dasktop) {
  document.getElementById("clear").addEventListener("click", async () => {
    await writeState({ entries: [] });
    await log("info", "历史已清空");
    await render();
  });

  await render();
} else {
  list.appendChild(hint("宿主能力桥不可用：这个页面不是由 Dasktop 打开的。"));
}

async function render() {
  const { entries } = await readState();

  list.innerHTML = "";

  if (entries.length === 0) {
    list.appendChild(hint("还没有历史记录。"));
    return;
  }

  for (const entry of entries) {
    const item = document.createElement("li");

    const status = document.createElement("span");
    status.className = "status";
    status.textContent = entry.status === 0 ? "失败" : String(entry.status);

    const target = document.createElement("span");
    target.className = "target";
    target.textContent = entry.url;

    const at = document.createElement("span");
    at.className = "at";
    at.textContent = formatTime(entry.at);

    item.append(status, target, at);
    list.appendChild(item);
  }
}

async function log(level, message) {
  try {
    await dasktop.log.write(level, message);
  } catch {
    return;
  }
}

function formatTime(value) {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString("zh-CN");
}

function hint(text) {
  const item = document.createElement("li");
  item.className = "muted";
  item.textContent = text;

  return item;
}
