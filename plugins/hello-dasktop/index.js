/*
 * 插件逻辑入口。
 *
 * 它由 index.html 用 <script type="module"> 引入——宿主不加载这个文件，也不知道它存在。
 * 宿主只做一件事：在页面自己的脚本执行之前，把能力桥挂到 `window.dasktop` 上。
 *
 * 桥里有什么由 plugin.json 的 permissions 决定：声明了 log:write 才有 dasktop.log，
 * 声明了 ui:notify 才有 dasktop.notify，没声明的连属性都不存在。所以这里先用
 * `dasktop.has(...)` 问一遍，再决定要不要接按钮。
 */

const note = document.getElementById("note");

function report(message) {
  note.textContent = message;
}

/*
 * `dasktop` 由宿主注入，直接用浏览器打开这个 HTML 时它不存在。
 * 这一层判断不是安全措施（桥本来就不是安全边界），只是为了不在控制台里抛一串
 * 与真正原因无关的 TypeError。
 */
if (!window.dasktop) {
  report("宿主能力桥不可用：这个页面不是由 Dasktop 打开的。");
} else {
  document.getElementById("meta-id").textContent = dasktop.plugin.id;
  document.getElementById("meta-version").textContent = dasktop.plugin.version;
  document.getElementById("meta-permissions").textContent =
    dasktop.plugin.permissions.length > 0
      ? dasktop.plugin.permissions.join("、")
      : "（未声明任何能力）";

  if (dasktop.has("log:write")) {
    document.getElementById("log").addEventListener("click", async () => {
      await dasktop.log.write("info", "来自 hello-dasktop 的一条日志");

      report("已写入日志。插件日志按插件分文件，位于应用数据目录的 plugin-logs/ 下。");
    });
  }

  if (dasktop.has("ui:notify")) {
    document.getElementById("notify").addEventListener("click", async () => {
      await dasktop.notify.send("Hello Dasktop", "这条通知由插件发起，宿主统一展示。");

      report("已发送通知，宿主的插件面板里也能看到它。");
    });
  }
}

/*
 * 所有插件页面共享同一个 origin，localStorage 是**共用**的。
 * 自己存东西一定要加插件名前缀，否则会和别的插件互相覆盖。
 */
localStorage.setItem("hello-dasktop:opened-at", new Date().toLocaleTimeString("zh-CN"));
