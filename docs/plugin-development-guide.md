# Dasktop 插件开发指南

> 目标读者：想在 Dasktop 里编写、安装或调试插件的开发者。
> 本文档聚焦**第三方网页插件包**：一个目录 + 一份 `plugin.json` + 若干网页文件。

## 一、插件是什么

Dasktop 的插件是**磁盘上的插件包**。宿主扫描应用数据目录下的 `plugins/` 文件夹，把每个子目录当成一个插件包；用户从「设置 → 插件」打开它时，宿主会新建一个窗口，用自定义协议加载插件自己的 HTML 页面，并在页面脚本执行前注入 `window.dasktop` 能力桥。

插件界面完全由插件作者控制：任意 HTML、CSS、JS。宿主不拼界面、不审查 DOM、不执行插件代码；插件要调系统能力，只能走 `window.dasktop`，每次调用宿主都会重新校验身份与权限。

## 二、最小插件

一个能跑起来的插件只需要两个文件：

```
my-plugin/
├── plugin.json
└── index.html
```

`plugin.json`：

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "0.1.0",
  "entry": "index.html",
  "permissions": []
}
```

`index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>我的插件</title>
  </head>
  <body>
    <h1>Hello Dasktop</h1>
    <p>插件 id：<span id="id"></span></p>
    <script type="module">
      if (window.dasktop) {
        document.getElementById("id").textContent = dasktop.plugin.id;
      }
    </script>
  </body>
</html>
```

把 `my-plugin` 整个目录复制到 `%APPDATA%\cn.syand.dasktop\plugins\` 下，重启或刷新「设置 → 插件」即可看到它。

## 三、插件包结构

```
<插件根目录>/
└── <plugin-id>/                 # 目录名必须与 plugin.json 的 id 一致
    ├── plugin.json              # 必需：清单
    ├── index.html               # 必需：入口页面（由 entry 指定）
    ├── index.js                 # 可选：页面逻辑，由 index.html 自己引入
    ├── style.css                # 可选：样式
    ├── history.html             # 可选：其它页面
    ├── state.js                 # 可选：页面间共享模块
    └── ...                      # 任意被页面引用的资源
```

- 插件根目录位于 `%APPDATA%\cn.syand.dasktop\plugins\`。
- 首次扫描时若目录为空，宿主会把仓库 `plugins/` 下的内置示例包全部复制进来。
- 扫描时会跳过 `.` 或 `_` 开头的目录。

## 四、plugin.json 配置清单

`plugin.json` 是插件的唯一入口配置，字段如下：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | `string` | 是 | 插件唯一标识，**必须与插件包目录名一致** |
| `name` | `string` | 是 | 展示名称，可包含中文 |
| `version` | `string` | 是 | 插件版本号，仅展示 |
| `entry` | `string` | 是 | 入口页面相对路径，必须指向包内真实存在的 HTML 文件 |
| `permissions` | `string[]` | 是 | 声明需要的能力权限（见第五节） |
| `window` | `object` | 否 | 窗口形态与作者建议尺寸（见第六节） |
| `hotkeys` | `array` | 否 | 声明全局热键（见第七节） |

完整示例：

```json
{
  "id": "translator",
  "name": "翻译助手",
  "version": "0.1.0",
  "entry": "index.html",
  "permissions": ["clipboard:read", "clipboard:write", "net:request"],
  "window": {
    "kind": "quick",
    "width": 520,
    "height": 360
  },
  "hotkeys": [
    {
      "id": "translate",
      "accelerator": "Alt+T",
      "title": "翻译剪贴板内容"
    }
  ]
}
```

## 五、能力权限与桥 API

插件需要在 `permissions` 中显式声明它需要的能力。宿主只开放以下 7 条权限，其余任何系统命令插件窗口都调不了：

| 权限 | 桥 API | 说明 |
|------|--------|------|
| `clipboard:read` | `dasktop.clipboard.read()` | 读取系统剪贴板文本 |
| `clipboard:write` | `dasktop.clipboard.write(text)` | 写入文本到系统剪贴板 |
| `fs:read` | `dasktop.fs.read(path)` | 读取插件包自身目录内的文本文件 |
| `fs:write` | `dasktop.fs.write(path, contents)` | 写入文本到插件包自身目录内 |
| `log:write` | `dasktop.log.write(level, message)` | 写入按插件隔离的运行日志 |
| `net:request` | `dasktop.net.request(options)` | 由宿主进程代发 HTTP(S) 请求，不受同源策略约束 |
| `ui:notify` | `dasktop.notify.send(title, message)` | 向宿主发送通知 |

### 桥 API 形状

注入后的 `window.dasktop` 结构如下：

```js
window.dasktop = {
  plugin: {
    id: "my-plugin",
    name: "我的插件",
    version: "0.1.0",
    permissions: ["clipboard:read"]
  },
  has(permission) { /* 返回 boolean */ },

  clipboard: { read(), write(text) },      // 需声明 clipboard:read / clipboard:write
  fs: { read(path), write(path, contents) }, // 需声明 fs:read / fs:write
  log: { write(level, message) },          // 需声明 log:write
  net: { request({ url, method?, body?, headers? }) }, // 需声明 net:request
  notify: { send(title, message) }         // 需声明 ui:notify
};
```

- **没声明的权限对应的命名空间不会出现**，而不是存在但调用报错。建议先用 `dasktop.has("xxx:yyy")` 判断再接事件。
- 所有能力方法都返回 `Promise`。
- 能力桥不是安全边界：插件可以绕过它直接调 `window.__TAURI_INTERNALS__.invoke(...)`，但宿主侧会按窗口标签和清单权限拒绝未授权调用。

### 各 API 详情

#### `dasktop.clipboard.read()`

```js
const text = await dasktop.clipboard.read();
```

读取系统剪贴板中的文本。剪贴板为空或非文本时行为由宿主定义；当前返回空字符串。

#### `dasktop.clipboard.write(text)`

```js
await dasktop.clipboard.write("要写入的文本");
```

写入文本到系统剪贴板，覆盖现有内容。

#### `dasktop.fs.read(path)`

```js
const content = await dasktop.fs.read("state.json");
```

- `path` 是相对于插件包目录的相对路径。
- 只能读取插件包自身目录内的文件，不能越出包目录（含 `..`、绝对路径、盘符、符号链接等都会被拒）。
- 返回文件内容的 UTF-8 字符串。
- 读取上限 4 MB。

#### `dasktop.fs.write(path, contents)`

```js
await dasktop.fs.write("state.json", JSON.stringify({ count: 1 }));
```

- 写入路径同样被限制在插件包自身目录内。
- 写入上限 4 MB。

#### `dasktop.log.write(level, message)`

```js
await dasktop.log.write("info", "用户点击了保存按钮");
```

- `level` 建议用 `debug` / `info` / `warn` / `error`。
- 日志文件位于 `%APPDATA%\cn.syand.dasktop\plugin-logs\<plugin-id>.log`。
- 单日志文件超过 512 KB 会自动截断重写。

#### `dasktop.net.request(options)`

```js
const response = await dasktop.net.request({
  url: "https://api.example.com/data",
  method: "POST",
  body: JSON.stringify({ key: "value" }),
  headers: { "Content-Type": "application/json" }
});
```

- `method` 默认 `GET`。
- 请求由宿主 Rust 进程发出，**不受浏览器同源策略限制**。
- 只允许 `http:` / `https:`。
- 超时 20 秒，响应体上限 2 MB。
- 返回 `{ status, body }`，`body` 是字符串。

#### `dasktop.notify.send(title, message)`

```js
await dasktop.notify.send("翻译完成", "结果已复制到剪贴板");
```

向宿主发送通知，宿主面板会展示通知流。

## 六、窗口配置

`plugin.json` 的 `window` 字段控制插件窗口的默认形态与尺寸：

```json
{
  "window": {
    "kind": "standard",
    "width": 720,
    "height": 680
  }
}
```

### `kind`：窗口形态

| 值 | 说明 |
|----|------|
| `standard`（默认） | 有标题栏、进任务栏、可缩放、关闭即销毁 |
| `quick` | 无边框、置顶、不进任务栏、不可缩放、居中，关闭改隐藏（浮层语义） |

`kind` 与热键正交：标准窗口也能被热键唤起，quick 窗口也能从设置页点开。

### `width` / `height`：作者建议尺寸

- 单位为逻辑像素。
- 可以只写其中一项，未写的那一维用全局默认值补齐。
- 会被夹取到允许范围：标准窗口 420×360 ~ 2560×2560，quick 窗口 320×200 ~ 2560×2560。

### 窗口尺寸的三级优先级

实际开窗尺寸按以下顺序收敛：

1. **用户为该插件记住的尺寸**（SQLite `plugin_window_sizes` 表）
2. **清单里作者声明的 `window`**（`plugin.json`）
3. **宿主全局默认值**（标准 560×640，quick 480×320）

用户手动调整窗口后关闭，最后尺寸会被写回第 1 级，此后该插件不再受清单与全局默认值影响，直到用户在设置页点「重置」。

## 七、全局热键配置

> **状态说明**：`plugin.json` 中声明热键、设置页展示与管理热键已落地；系统级全局热键注册与页面端 `dasktop.hotkey` 消费 API 属于阶段二能力，当前版本尚未完全注入。请以下游实现为准。

在 `plugin.json` 中用 `hotkeys` 数组声明全局热键：

```json
{
  "hotkeys": [
    {
      "id": "translate",
      "accelerator": "Alt+T",
      "title": "翻译剪贴板内容"
    }
  ]
}
```

| 字段 | 说明 |
|------|------|
| `id` | 热键在包内唯一标识，页面靠它区分唤起意图 |
| `accelerator` | 快捷键字符串，如 `Alt+T`、`Ctrl+Shift+P` |
| `title` | 面向用户的中文说明，设置页展示 |

### 快捷键写法规则

- 必须至少包含一个修饰键和一个主键。
- 可接受的修饰键：`Ctrl` / `Control` / `Alt` / `Shift` / `Meta` / `Cmd` / `Command` / `Option`。
- 不允许单独使用 `Win` / `Super` 键（系统保留，注册会失败）。
- 大小写不敏感，`alt + t` 与 `Alt+T` 等价。

### 冲突裁决

多个插件声明同一组合键时，按插件 id 字典序「先到先得」，后到的热键状态显示为 `conflict` 且不注册。

### 用户覆盖

用户可在「设置 → 插件」的热键管理中：

- 修改某个热键的快捷键；
- 禁用某条热键；
- 查看冲突 / 非法 / 系统保留等状态。

## 八、页面编写规范

### 1. 相对路径是唯一的包内寻址方式

插件页面 URL 形如 `http://plugin.localhost/<plugin-id>/index.html`。包内链接必须写相对路径：

```html
<!-- 正确 -->
<a href="./history.html">历史</a>
<script type="module" src="./index.js"></script>

<!-- 错误：/history.html 会被当成插件 id，必然 404 -->
<a href="/history.html">历史</a>
```

### 2. 所有插件共享同一个 origin

所有插件页面都跑在 `http://plugin.localhost` 这一 origin 下，因此 `localStorage`、`IndexedDB`、`sessionStorage`、`Cookie` 是**公用的**。自己存数据时一定要带插件名前缀：

```js
localStorage.setItem("my-plugin:theme", "dark");
```

### 3. `fetch` 受同源策略约束

插件页面自己的 `fetch` 仍是浏览器行为，受 CORS 限制。想访问不开放 CORS 的接口，请用 `dasktop.net.request`。

### 4. 主题跟随系统

插件页面在独立 WebView 中，读不到宿主主题状态。用 `prefers-color-scheme` 跟随系统：

```css
@media (prefers-color-scheme: dark) {
  body { background: #1b1d22; color: #e6e8ee; }
}
```

### 5. 直接用浏览器打开 HTML 时 `window.dasktop` 不存在

这是正常行为。建议做兜底判断：

```js
if (!window.dasktop) {
  // 禁用依赖宿主能力的功能，或给出提示
}
```

### 6. `window.close()` 可用

插件页面可以调用 `window.close()` 关闭自己。quick 窗口的关闭语义是隐藏而非销毁。

## 九、示例插件说明

仓库 `plugins/` 目录下有三个示例插件，可直接参考：

| 插件 | 能力 | 看点 |
|------|------|------|
| `hello-dasktop` | `log:write`、`ui:notify` | 最小插件，展示 `dasktop.plugin` 与 `dasktop.has` 用法 |
| `http-console` | `clipboard:write`、`fs:read`、`fs:write`、`log:write`、`net:request`、`ui:notify` | 多页面跳转、模块拆分、`net.request` 代发请求 |
| `json-formatter` | `clipboard:read`、`clipboard:write` | 较复杂的页面交互、localStorage 命名前缀 |

## 十、调试与问题排查

### 插件没有出现在列表里

- 检查插件目录是否以 `.` 或 `_` 开头（会被跳过）。
- 检查 `plugin.json` 的 `id` 是否与目录名完全一致。
- 打开「设置 → 插件」的开发者工具，看 `list_plugins` 是否报错。

### 插件显示「不可用」

面板会直接给出原因，常见情况：

- `plugin.json` 缺失或 JSON 解析失败；
- `entry` 指向的文件不存在；
- `permissions` 中声明了宿主不认识的权限。

### 点击「打开」没反应

- 打开设置窗的开发者工具看 `console.error`。
- 窗口创建失败只记日志、不弹提示。

### 插件窗口一片空白

- 在插件窗口右键打开开发者工具，看 Network 是否有 404（常见于 `.js` 文件路径写错或漏传）。
- 检查包内引用是否写成 `/xxx.js` 这类绝对路径。

### 窗口空白且宿主界面一起卡死

这是主线程死锁的典型症状。通常与插件开发无关，而是宿主建窗命令被写成了同步 `fn`。如果自行修改宿主代码，请保持 `open_plugin_window` 为 `async fn`。

### `window.dasktop` 是 `undefined`

- 页面不是由 Dasktop 打开的（例如直接用浏览器打开 HTML）。
- 宿主没有正确注入初始化脚本。

### 某个 `dasktop.xxx.yyy` 方法不存在

- 先检查 `plugin.json` 的 `permissions` 是否声明了对应权限。
- 再核对方法名是否拼写正确（参考第五节表格）。

### 能力调用报权限错误

- 报「未声明权限」：第二层清单权限拦住，去 `plugin.json` 补声明。
- 报 `command not allowed`：第一层 ACL 拦住，检查宿主 `permissions/plugin-capabilities.toml`。

### 改了页面但窗口里还是旧的

插件窗口不会感知磁盘变化。关闭窗口重开即可；协议响应带 `Cache-Control: no-store`，不存在缓存问题。

### 查看插件输出

- 插件日志：`%APPDATA%\cn.syand.dasktop\plugin-logs\<plugin-id>.log`
- 页面 `console.log`：在插件窗口的开发者工具里查看

## 十一、提交前校验

如果你是项目贡献者，修改插件或宿主能力后请跑：

```powershell
# 插件包契约校验：清单、引用、权限、桥调用点核对
pnpm verify:plugins

# 应用命令 ACL 校验：能力命令与宿主命令不相交
pnpm verify:acl

# 前端类型检查与构建
pnpm build
```

`pnpm verify:plugins` 会检查：

- `plugin.json` 可解析，`id` 与目录名一致；
- `entry` 存在且是 HTML；
- 包内 HTML/JS 的相对引用都指向真实文件，不以 `/` 开头，不是裸模块名；
- 每个脚本文件都被引用过（无死文件）；
- `permissions` 都在宿主认识的权限集合内；
- 源码中每个 `dasktop.xxx.yyy(...)` 调用都已在 `plugin.json` 声明对应权限。

## 十二、给宿主扩展新能力的简要说明

如果要给插件新增能力，需要同时改动以下 4 处并保持同步：

1. **Rust 命令**：在 `src-tauri/src/commands/plugin.rs` 新增 `#[tauri::command]`，并在 `lib.rs` 注册。
2. **ACL 文件**：在 `src-tauri/permissions/plugin-capabilities.toml` 加入新命令。
3. **服务层用例**：在 `src-tauri/src/services/plugin/mod.rs` 中封装，第一行调用 `require_permission`。
4. **桥与类型**：
   - `src-tauri/src/services/plugin/bridge.js`：在 `CAPABILITY_TABLE` 加映射，并挂载方法；
   - `src/entities/pluginPackage/permissions.ts`：加 `{ permission, command, summary }`；
   - `src/entities/pluginPackage/types.ts`：把新权限加进 `PLUGIN_PERMISSIONS`；
   - `src-tauri/src/domain/plugin/contract.rs`：加权限常量并加入 `PLUGIN_PERMISSIONS`。

改动后必须跑 `pnpm verify:plugins` 和 `pnpm verify:acl`，否则会在构建期漏掉不一致。

---

更多实现细节请参阅 `docs/plugin-package-framework.md`。