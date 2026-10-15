# 插件包框架

Dasktop 的可插拔包框架：插件以**磁盘上的插件包**形式存在，一个包就是一个目录，里面是一份
`plugin.json` 加若干网页文件。宿主扫描这些目录，把它们登记到「设置 → 插件」里；用户点「打开」
时，宿主在 Rust 侧开一个窗口，用自定义协议**把插件自己的页面加载进去**，并在页面脚本执行之前
注入一层**能力桥**（`window.dasktop`），插件据此调用宿主开放的系统功能。

插件界面完全由插件作者掌控——任意 HTML、CSS、JS。宿主不拼界面、不审查 DOM、不执行插件代码；
插件要触达宿主能力，只能走桥，而桥的每一次调用都会在宿主侧重新判定身份与权限。

与 `feat/plugin-system` 分支上的 uTools 式内置插件（Vue 组件编译进宿主、面向命令面板）
是两套并行机制：本框架面向「用户自己放进去的第三方网页」，关注的是**加载边界**与**能力边界**。

## 一、整体架构

```
┌────────────────────────────────────────────────────────────────────┐
│                        宿主程序（Tauri App）                        │
│                                                                    │
│  ┌────────────────────────────┐   ┌─────────────────────────────┐  │
│  │         Rust 侧            │   │          前端侧              │  │
│  │                            │   │                             │  │
│  │ commands/plugin.rs         │   │ entities/pluginPackage/     │  │
│  │  ├ list_plugins            │◄─►│  ├ types       传输契约       │  │
│  │  ├ open_plugin_window ─┐   │IPC│  ├ permissions 权限映射表     │  │
│  │  └ 五条能力命令         │   │   │  ├ api   invoke 封装         │  │
│  │                        │   │   │  ├ loader 扫描 → 运行时记录   │  │
│  │ services/plugin/       │   │   │  └ window  窗口标签/关闭      │  │
│  │  ├ mod.rs 建窗+身份+权限│   │   │                             │  │
│  │  ├ bridge.rs 生成桥脚本 ─┼───┼───┼─►注入插件窗口              │  │
│  │  └ protocol.rs 资源协议 │   │   │                             │  │
│  │                        │   │   │ windows/settings/           │  │
│  │ infrastructure/        │   │   │  └ panels/PluginsPanel.vue  │  │
│  │  ├ filesystem/plugin_pkg   │   │                             │  │
│  │  ├ filesystem/plugin_log   │   │                             │  │
│  │  └ http/               │   │   │                             │  │
│  └────────────────────────────┘   └─────────────────────────────┘  │
└───────────┬────────────────────────────────────┬───────────────────┘
            │ plugin 协议                         │ invoke
            │ http://plugin.localhost/<id>/…      │ （仅被 capability 覆盖的窗口）
            ▼                                    ▼
┌───────────────────────────────────┐   ┌───────────────────────────┐
│      插件窗口（每个插件一个）        │   │    设置窗口 / Box 窗口      │
│      label: plugin_<id>            │   │  被 default capability 覆盖│
│      加载插件作者写的网页            │   │  插件列表、打开入口         │
│      ＋宿主注入的 window.dasktop    │   └───────────────────────────┘
│      ✓ plugin capability：5 条能力  │
│      ✗ 其余应用命令一律被 ACL 拒掉    │
└───────────────────────────────────┘
```

一句话概括隔离模型：**插件窗口的 capability 只授予五条能力命令，除此之外一条应用命令都调不了；
这五条命令在服务层还要再对「插件清单声明的权限」做一次判定。**

这个模型里有一处反直觉、并且**曾经真的踩进去过**的地方，值得单独说清。

Tauri 2 的 `is_local_url` 把 `http://plugin.localhost` 判定为**本机来源**（Windows / Android
上自定义协议就映射成 `http://<scheme>.localhost`）。而 Tauri 对**应用自己的命令**要不要做权限
检查，判据是这个（`tauri/src/webview/mod.rs`）：

```rust
if (plugin_command.is_some() || has_app_acl_manifest || !is_local) && … { /* 拒绝 */ }
```

插件窗口是「本机来源」，命令名又都不带 `plugin:` 前缀（我们的命令叫 `plugin_http_request`，
是下划线不是冒号），于是它**只可能命中 `has_app_acl_manifest`**。而这项又取决于
`src-tauri/permissions/` 下有没有 app 级权限定义——**该目录不存在时，这道检查会被整条跳过**，
插件页面里任意一段 JS 只要调 `window.__TAURI_INTERNALS__.invoke("delete_desktop_items", {…})`
就会直接执行。capabilities 白名单管的是 `core:` 这类**插件**命令，管不住应用命令，
所以那时候的「不给白名单」其实什么都没挡住。

因此这套框架的 ACL 由三个文件共同成立：

1. `src-tauri/permissions/host-commands.toml` —— 宿主命令的 app 级权限定义，它的存在让应用命令
   进入鉴权；
2. `src-tauri/permissions/plugin-capabilities.toml` —— 只含五条能力命令的 app 级权限定义；
3. `capabilities/default.json` 覆盖宿主窗口、`capabilities/plugin.json` 覆盖 `plugin_*`
   —— **两份 capability 的命令集合刻意不相交**。

少了第一条，三道全部形同虚设；少了后两条，插件窗口拿回全部能力或拿不到任何能力。`pnpm verify:acl`
把这几条都盯住，特别是「两份 capability 的交集必须为空」（详见「开发与调试」）。

还有一处别想当然：`__TAURI_INTERNALS__` 的注入脚本是加在**每个** Tauri 创建的 webview 上的
（`manager/webview.rs`），插件页面**拿得到**调用入口。拦住它的是上面这套 ACL，
不是「拿不到入口」——写注释时按后者理解，会得出「只要不注入就没有风险」这种错误结论。

同理，注入进去的 `window.dasktop` **不是**安全边界：插件把自己的页面改成直接
`__TAURI_INTERNALS__.invoke(…)` 完全绕得过它。桥只是便利层，判据始终在宿主侧。

## 二、职责划分

### Rust 侧

| 模块 | 职责 |
|---|---|
| `commands/plugin.rs` | IPC 边界；五条能力命令都带 `window: Window` 参数以取得**调用方身份** |
| `services/plugin/mod.rs` | 解析插件根目录、编排扫描、**建窗并注入桥**、收敛调用方 id、判清单权限、包内文件访问、转发 HTTP、把通知落到 Tauri 事件 |
| `services/plugin/bridge.rs` | **生成能力桥注入脚本**：把插件身份与权限集合序列化成一行 JSON，拼在内嵌的 `bridge.js` 之前 |
| `services/plugin/bridge.js` | 注入脚本真身（`include_str!` 内嵌）。定义 `window.dasktop` 的 API 形状，按声明逐项挂载能力 |
| `services/plugin/protocol.rs` | **`plugin` 协议处理器**：把 URL 解析成包内文件、推断 MIME、回状态码 |
| `infrastructure/filesystem/plugin_package.rs` | 目录扫描、清单解析、**包内路径沙箱**、资源读写、内置示例包播种 |
| `infrastructure/filesystem/plugin_log.rs` | 按插件分文件的日志追加与容量控制 |
| `infrastructure/http/` | HTTP 客户端：URL/方法校验、体积上限、响应头归一（对应 `net:request` 能力） |
| `domain/plugin/` | 契约常量（含窗口尺寸/标签前缀/权限名）、清单与扫描结果类型、网络请求/响应类型、内嵌示例包声明 |
| `permissions/host-commands.toml` | **宿主命令的 app 级 ACL 定义**（35 条），经 `default` capability 授予宿主窗口 |
| `permissions/plugin-capabilities.toml` | **能力命令的 app 级 ACL 定义**（5 条），经 `plugin` capability 授予插件窗口 |
| `capabilities/default.json` | 覆盖 `main` / `box_*` / `box_menu` / `drag_preview` |
| `capabilities/plugin.json` | 覆盖 `plugin_*`，**只授 `allow-plugin-capabilities`** |

### 前端侧

| 模块 | 职责 |
|---|---|
| `entities/pluginPackage/types.ts` | 传输契约与运行时视图两组类型、权限联合类型（`PLUGIN_PERMISSIONS`） |
| `entities/pluginPackage/permissions.ts` | **权限映射表**：权限字符串 → 宿主命令；加载期未知权限预检 |
| `entities/pluginPackage/api.ts` | 扫描/建窗/打开目录三个 `invoke` 封装 |
| `entities/pluginPackage/loader.ts` | **加载器**：扫描 → 生成运行时记录；持有快照与通知订阅 |
| `entities/pluginPackage/window.ts` | 窗口标签锚点（`pluginWindowLabel`）与关闭 |
| `entities/pluginPackage/index.ts` | 该领域的对外入口 |
| `shared/ipc/pluginPackage.ts` | 插件通知事件名与订阅 |
| `windows/settings/panels/PluginsPanel.vue` | 宿主面板：目录、可用状态、权限标签、通知流 |

对比此前版本，前端少掉了三块：`context.ts`（能力桥）、`worker/`（Worker 宿主与运行时）、
`windows/pluginHost/`（声明式界面渲染器）。它们存在的唯一理由是「插件被关在 Worker 里造不出
DOM」，页面模式下这个前提消失了。现在的「桥」在 Rust 侧（`services/plugin/bridge.rs`），因为
**初始化脚本只能在建窗时挂**，而建窗已经搬到了 Rust。

插件窗口的创建也从前端搬到了 Rust，前端只留一个 `openPluginWindow(pluginId)` 封装。这不是为了
「少写一行」，而是被能力桥倒逼的结果：前端的 `new WebviewWindow` 不透出
`initialization_script`，桥就没有别的落点。

## 三、插件包规格

```
<插件根目录>/
└── my-plugin/
    ├── plugin.json      # 必需：清单
    ├── index.html       # 必需：入口页面（由清单 entry 指定）
    ├── index.js         # 可选：页面逻辑（ESM），由 index.html 自己 <script type="module"> 引入
    ├── history.html     # 可选：想有几个页面就有几个
    ├── state.js         # 可选：页面间共享的模块
    └── ...              # 可选：CSS、JS、图片、字体、wasm，随页面引用
```

插件根目录位于应用数据目录：`%APPDATA%\cn.syand.dasktop\plugins`，
可在「设置 → 插件」中直接打开。目录下没有任何子目录时，宿主会写入仓库内 `plugins/` 下
**全部**内置示例包（当前两个）。

### 清单字段

| 字段 | 说明 |
|---|---|
| `id` | 插件唯一标识，**必须与插件包目录名一致**，否则该包被标记为不可用 |
| `name` | 展示名称 |
| `version` | 插件版本号 |
| `entry` | 入口页面相对路径，只允许包内相对路径，且文件必须真实存在 |
| `permissions` | 声明需要的能力列表（见「权限与能力」） |
| `window` | 可选。作者建议的窗口尺寸 `{ "width": 720, "height": 680 }`，取值规则见下 |

`entry` 指向的文件在**扫描阶段**就会校验存在性：少了这道校验，包能正常显示在设置页里，
直到用户点开窗口才看到一片空白，那时很难联想到是清单里文件名写错了。

`permissions` 同理在扫描阶段预检：出现宿主不认识的权限，整包记为「不可用」并列出该项。

### 窗口尺寸：三级优先级

插件窗口最后有多大，是三个来源按序收敛的结果：

| 优先级 | 来源 | 存放位置 |
|---|---|---|
| 1 | **用户为该插件记住的尺寸** | SQLite `plugin_window_sizes` 表，主键 `plugin_id` |
| 2 | **清单里作者声明的 `window`** | 插件包的 `plugin.json` |
| 3 | **宿主的全局默认值** | SQLite `app_settings` 表的 `pluginWindowWidth` / `pluginWindowHeight` |

三条约定：

- **全局默认必须排在清单之后**。它始终有值（默认 560×640），一旦让它盖在清单之上，
  作者声明的尺寸就永远不生效，而现象是「宿主没读我的清单」，很难想到是顺序问题。
- **宽高各自独立回落**。`window` 可以只写 `width`，没写的那一维用全局默认值补上，
  不会因为少写一项就把整段声明丢掉。
- **越界值一律夹取到允许范围**（当前 420×360 至 2560×2560）而不是报错。尺寸不属于权限，
  一个写大了的数字不需要让整个插件变成不可用。设置页输入、清单声明、窗口写回三条路径
  都过同一套夹取规则，它只在 Rust 侧实现一次（`domain/plugin/window_size.rs`）；
  扫描结果里带回的 `windowSize` 就是收敛后的值，设置页直接展示，不再自行推导。
  设置页输入框的可选范围常量仍有一份前端副本，由 `pnpm verify:plugins` 与 Rust 常量比对。

用户没有从设置页设置、也没有拖过窗口时，第 1 级不存在，窗口按清单声明或全局默认打开；
**窗口一旦被手动调整，关闭时最后尺寸会被写回第 1 级**（逻辑像素，最大化状态不记录），
此后这个插件就不再受清单与全局默认值影响，直到用户在设置页里点「重置」。
写入由宿主 Rust 侧在 `CloseRequested` 时完成，不走 IPC，因此 Tauri 的能力清单与
这套机制无关。

### 入口文件的约定：宿主只加载 HTML，**不加载 JS**

这是最容易被误解的一点。宿主加载的是 `entry` 指向的 **HTML**，`index.js` 由页面自己引入：

```html
<!-- my-plugin/index.html -->
<script type="module" src="./index.js"></script>
```

`plugin.json` 里**没有**、也不应该有 `main` / `entry` 指向 JS 的字段。理由是：如果宿主去执行
JS、页面又负责 UI，就成了两个 JS 环境，插件作者要同时面对「宿主给我的模块作用域」和「页面的
DOM」，桥要挂在哪一边都不自然。现在只有一个环境——页面自己的模块——桥只是在它之前挂到
`window.dasktop` 上。

宿主对这个文件一无所知：不解析、不检查、不执行。它只在页面脚本执行之前注入桥。

### 页面怎么写

就是写网页。除了 `window.dasktop` 是宿主注入的之外，没有任何 SDK、没有必需的导出、没有
生命周期函数——**宿主从不执行插件的代码**，它只是把文件交给 WebView。

`plugins/hello-dasktop/` 是最小示例（HTML + JS，用桥写日志与发通知），
`plugins/http-console/` 演示多页面跳转、模块拆分（`state.js`）与桥上的 `net` / `fs` 能力。

几条实际会碰到的约束：

- **相对链接是唯一的包内寻址方式**。页面 URL 形如
  `http://plugin.localhost/my-plugin/index.html`，所以 `<a href="./history.html">` 会解析到
  同一个包里。而 `<a href="/history.html">` 会解析到**协议根**（`/history.html` 会被当成插件
  id），必然 404 —— 包内引用一律写相对路径。
- **所有插件共享同一个 origin**（`http://plugin.localhost`），因此 `localStorage`、
  `IndexedDB`、`sessionStorage` 是**公用**的。自己的 key 一定要带插件名前缀，
  否则会和别的插件互相覆盖。
- **`fetch` 受同源策略约束**。插件页面发起的请求需要目标接口返回 `Access-Control-Allow-Origin`。
  想访问不开放 CORS 的接口，得走桥上的 `dasktop.net.request`（由宿主进程发出，不受此限）。
- **深浅色跟随系统**，用 `prefers-color-scheme` 判断。插件页面在独立 WebView 里，
  跨窗口读不到宿主的主题设置。
- **`window.close()` 可用**：插件窗口是普通窗口，页面自己就能关掉自己。
- **直接用浏览器打开 HTML 时 `window.dasktop` 不存在**。这不是错误——桥只由宿主注入。
  需要一个判断来禁用功能，而不是假设它一定在。

## 四、资源协议

插件页面的 URL 前缀**不跨平台一致**：Windows（WebView2）与 Android 把它映射成
`http://plugin.localhost`，其余平台是 `plugin://localhost`。这条判断只在 Rust 侧一处
（`services/plugin::asset_base_url`），页面地址由 `resolve_page_url` 直接给出完整结果，
前端不再重复实现，也不再有 `plugin_asset_base_url` 这条命令。

URL 必须是**多段**形式，逐段拼装并转义：

```rust
fn encode_page_path(plugin_id: &str, entry: &str) -> String {
    let mut path = String::with_capacity(plugin_id.len() + entry.len() + 2);
    path.push('/');
    path.push_str(plugin_id);
    for segment in entry.split('/').filter(|segment| !segment.is_empty()) {
        path.push('/');
        path.push_str(&segment.replace('%', "%25"));   // 只转义 %，不碰 /
    }
    path
}
```

两个坑都在这几行里：整串 `encodeURIComponent` 会把 `/` 一起编成 `%2F`，把多段路径压成一段；
而 `Url::set_path` 又**不会**帮你转义一个裸 `%`，`100%.html` 会变成非法转义序列。所以是
「先按段切，再逐段转义 `%`」。`path_stays_multi_segment` / `encodes_each_segment_separately` /
`escapes_bare_percent` 三个测试分别盯这三点。

协议处理器的职责：

- 解析 `/<插件id>/<相对路径>`，id 先过白名单校验；
- 走**同一套**路径沙箱（`resolve_sandboxed_path`），页面资源同样不能逃出插件包目录；
- 失败区分状态码：`403` 表示越权被拦、`404` 表示文件不存在、`400` 表示地址不合法。
  两者混在一起的话，作者写错一个相对路径会被误读成安全拦截，反过来也一样；
- MIME 用 Tauri 的 `MimeType::parse_with_fallback`（内容嗅探优先、扩展名兜底，兜底取
  `application/octet-stream` 而不是 HTML）—— 一段未知二进制被当 HTML 解析只会让 WebView
  对着乱码排版；
- 响应带 `Cache-Control: no-store`。资源就是磁盘上的文件，作者改完页面重开窗口就该看到新
  内容；少了这一条 WebView 会拿缓存继续显示旧页面，排查时极具误导性。

## 五、能力桥（`window.dasktop`）

这是「插件 JS 调系统功能」的落点。宿主在**建窗时**把 `bridge.js` 作为初始化脚本挂上，
它在插件页面的任何脚本之前执行。

### API 形状

```js
window.dasktop = {
  plugin: { id, name, version, permissions: [...] },   // 只读，来自清单
  has(permission),                                     // 清单里有没有声明

  fs:  { read(path), write(path, contents) },          // fs:read / fs:write
  log: { write(level, message) },                      // log:write
  net: { request({ url, method?, body?, headers? }) }, // net:request
  notify: { send(title, message) },                    // ui:notify
};
```

`window.dasktop` 整体 `Object.freeze`，各命名空间也冻结。

**只挂载清单里声明过的能力**——没声明 `net:request` 的插件，`dasktop.net` 这个属性**根本
不存在**，而不是「存在但一调就报错」。这样配置错误在 `dasktop.net.request(...)` 那一行立刻
以 `TypeError` 暴露，比等到宿主返回一个权限错误更早、更好定位。`dasktop.has(...)` 让插件能
在接线前先问一遍，示例插件正是用它决定接不接按钮。

### 四个必须守住的约定

写进 `bridge.js` 顶部注释，改动这个文件前先读它们：

1. **这层不是安全边界**。判据在 Rust 侧（调用方窗口标签 + 插件清单）。插件改成直接
   `__TAURI_INTERNALS__.invoke(...)` 完全绕得过这层，但宿主照样拒。别把「插件只能通过
   dasktop 调」当安全假设。
2. **只挂载声明过的能力**（见上）。
3. **`__TAURI_INTERNALS__` 延迟取用**。本脚本与 Tauri 自己的初始化脚本谁先执行没有保证，
   IIFE 执行那一刻它可能还没挂上，所以只在真正发起调用时才去读。
4. **`CAPABILITY_TABLE` 的格式别改**。它是给校验脚本读的：

```js
var CAPABILITY_TABLE = {
  "fs.read": "fs:read",
  "fs.write": "fs:write",
  "log.write": "log:write",
  "net.request": "net:request",
  "notify.send": "ui:notify",
};
```

`scripts/verify-plugins.mjs` 解析它，把插件源码里出现的 `dasktop.xxx.yyy(...)` 映射成权限，
再核对 `plugin.json` 有没有声明。**这张表是「桥的方法」与「权限名」之间的唯一映射**，漏一项
就等于放行一个未声明权限的调用点。

### 配置注入：为什么是「一行 JSON 拼在脚本前面」

`bridge.rs` 把插件身份与权限集合序列化成一行 JSON，赋给 `window.__DASKTOP_BRIDGE__`，
**拼在内嵌脚本之前**：

```rust
Ok(format!("window.__DASKTOP_BRIDGE__ = {json};\n{BRIDGE_SOURCE}"))
```

用 `serde_json::to_string` 而不是手写拼接，是因为 `manifest.name` 来自磁盘、会被塞进一段
**正在执行的 JS**——手拼一个含 `"` 或换行的插件名就是一个代码注入点。
`manifest_values_cannot_break_out_of_the_config_line` 测试盯这一条，
`config_line_precedes_bridge_source` 盯顺序（配置必须在脚本读它之前就位）。

### 身份判定：标签优先，参数只作兜底

五条能力命令都带一个 `window: Window` 参数，不是为了操作窗口，而是为了拿**调用方身份**：

```rust
pub fn resolve_caller_plugin_id(window_label: &str, claimed_plugin_id: &str) -> String {
    window_label
        .strip_prefix(PLUGIN_WINDOW_LABEL_PREFIX)   // "plugin_"
        .map(str::to_string)
        .unwrap_or_else(|| claimed_plugin_id.to_string())
}
```

插件窗口的标签 `plugin_<id>` 由宿主建窗时写死，插件页面改不了（改标签要 `core:window` 权限，
而插件窗口一条 Tauri 权限都没有）。所以**标签形如 `plugin_` 就一律以标签为准，忽略插件传来的
`plugin_id`**；不是插件窗口（宿主自己的窗口）时才采纳参数。

这条规则换来一个不变量：**插件只能以自己的身份调能力**。没有它，插件在页面里填一个别人的 id
就能读写别人的包内文件、以别人的名义发请求和通知。三个测试盯它：
`window_label_wins_over_claimed_id` / `host_windows_keep_the_argument` /
`label_prefix_is_stripped_only_once`。

注意桥自己也在每个 payload 里带 `pluginId: config.id`——这**不是**为了被信任，而是为了让
宿主窗口（没有 `plugin_` 前缀）调用这些命令时也有一个 id 可用。

## 六、加载流程

```
1. 设置页根组件挂载
   └─► initializePluginRuntime()（幂等，共享同一个 Promise）
       ├─► 订阅插件通知事件
       └─► list_plugins 扫描插件根目录
           （目录不存在则创建；目录下无子目录时写入全部内置示例包）

2. 对每个插件包（纯计算，不执行任何插件代码）
   ├─► 清单不可解析 / id 与目录名不一致 → 记为「不可用」并继续下一个
   ├─► 入口页面路径非法或不存在 → 记为「不可用」
   ├─► 权限预检：出现宿主不认识的权限 → 记为「不可用」并列出该项
   └─► 全部通过 → 记为「可用」

3. 用户点插件卡片上的「打开」
   └─► openPluginWindow(pluginId)  ──IPC──►  open_plugin_window（Rust）
       ├─► id 校验 → 建窗标签 label = plugin_<id>
       ├─► 该窗口已存在 → unminimize + show + set_focus，**不重新导航**
       └─► 不存在 → 读清单 → 预检权限与入口 → 解析窗口尺寸
           ├─ 记忆尺寸（plugin_window_sizes）→ 清单 window → 全局默认设置
           └─ WebviewWindowBuilder
              ├─ 目标 URL = plugin 协议 + /<id>/<entry>
              ├─ 注入初始化脚本 = 配置行 + bridge.js
              ├─ build() → 挂 CloseRequested 监听：把最后尺寸写回 plugin_window_sizes
              └─ show + set_focus
```

关键点：

- **加载器不执行插件代码，也没有「卸载」**。它只把磁盘扫成一份可展示的记录，插件窗口的生命
  周期跟宿主这边没有交集，因此没有需要回收的资源。
- **单个插件失败不影响其它插件，也不中断宿主启动**。所有失败都收敛成记录里的 `error` 字段，
  设置页的 `onMounted` 对扫描也不做 `await`。
- **可用状态只有两种**（`ready` / `failed`）。页面模式下插件不需要被「激活」，用
  「已加载」会让人误以为宿主已经把插件代码跑起来了。
- **已存在的窗口只聚焦、不重载**。用户在插件页面里可能已经翻到第二页，重载会把他弹回入口。
  先 `unminimize` 再 `show`：上次可能是被最小化关掉的，只 `show` 会留下一个不可见的窗口，
  用户点「打开」看起来毫无反应。
- **建窗在 Rust 侧**（`open_plugin_window`），前端不再持有窗口创建细节，见「能力桥」。
- **建窗命令必须是 `async`**，理由见下。

### 为什么建窗命令必须 `async`

这是这套框架里第二个「写错了会静默失效」的地方，而且症状极具误导性：**插件窗口开出来是
一片空白，同时整个宿主界面一起卡死**。窗口确实建出来了（原生窗口先落地），但 WebView2
没初始化完，主线程被自己锁住。

推导链（三处源码）：

1. WebView2 的 IPC 回调跑在 **UI 线程**上，而 Tauri 注册的 handler 只是**直接调用**命令
   （`tauri-runtime-wry/src/lib.rs::create_ipc_handler`，`Box::new(move |request| { handler(...) })`
   ——没有任何线程切换）；
2. 所以**同步命令就在主线程上就地执行**；
3. 而 `create_window` 判断「当前线程 == 主线程」后，会**忽略事件循环代理、就地执行 `Message::CreateWindow`**
   （同文件 `send_user_message`：`if current_thread().id() == context.main_thread_id { handle_user_message(...) }`）。

于是同步命令里的 `.build()` 变成「在 WebView2 的 `WebMessageReceived` 回调里同步创建第二个
WebView2 controller」——controller 的初始化要等消息循环转起来，而消息循环正卡在这个回调里
出不去，**主线程死锁**。

写成 `async fn` 之后：Tauri 的命令宏走 `InvokeResolver::respond_async` →
`async_runtime::spawn`，落到 tokio **多线程**运行时的 worker 线程上；此时 `create_window`
走事件循环代理，建窗由主线程在事件循环里正常完成。（`async_runtime` 的默认运行时是
`TokioRuntime::new()`，即多线程调度器——若将来有人把它换成 `current_thread`，这个解法会失效。）

旁证：Tauri 自己的 `plugin:window|create` 命令就是 `async fn`（`tauri/src/window/plugin.rs:67`），
同一个原因。前端 `new WebviewWindow(...)`（Box 窗口走的路）之所以一直没问题，也是因为它最终
调的是那条 async 命令。

**别把它改回同步。** 改回去不会报错、不会编译失败，只会在运行时把宿主和插件窗口一起冻住。


## 七、权限与能力

这里有**两个不同层级**的东西共用「权限」这个词，混着看会得出错误结论，先分开。

### A. 窗口级 ACL：哪个窗口能调哪些命令

由 `permissions/*.toml`（定义）+ `capabilities/*.json`(授予）组成，是运行期真正生效的**第一层**。

| capability | 覆盖窗口 | 授予的 app 权限 | 效果 |
|---|---|---|---|
| `default` | `main` / `box_*` / `box_menu` / `drag_preview` | `allow-host-commands`（35 条） | 宿主窗口能调全部应用命令 |
| `plugin` | `plugin_*` | `allow-plugin-capabilities`（5 条） | 插件窗口只能调那五条能力命令 |

两份 capability 的命令集合**必须不相交**：共用一份的话，以后每加一条宿主命令都会顺带送插件
一条能力。`pnpm verify:acl` 的 `checkPluginWindowScope` 分三种情况分别报错——越权（插件窗口
拿到宿主命令）/ 缺授权（能力命令没给全）/ 多授权（超出 `permissions.ts` 的映射表）。

注意粒度仍然是**窗口**：这层只能表达「插件窗口能调这 5 条命令」，不能表达「插件 A 能调、
插件 B 不能」。

### B. 插件级清单判定：这个插件声明了没有

第二层判定在**服务层的每条能力用例内部**，粒度是**插件**：

```rust
pub fn read_plugin_file(app, plugin_id, relative_path) -> Result<String, String> {
    require_permission(app, plugin_id, PLUGIN_PERMISSION_FS_READ)?;   // 每条用例第一行
    ...
}
```

`require_permission` 每次重新读该插件的清单来判——不是缓存、不是建窗时判一次。理由是插件包
在磁盘上、用户随时可以改 `plugin.json`，判定必须以「当前清单」为准。

两层缺一不可：少了 A，插件窗口能调任意命令；少了 B，任何插件只要它想，就能调全部五条能力
命令，不管它声明了什么（`permissions` 沦为一纸文案）。

`permissions.ts` 描述的是「权限 → 宿主命令」，既是面板上的文案来源，也是校验脚本核对
capability 的基准：

| 权限 | 桥上方法 | 对应宿主命令 | 说明 |
|---|---|---|---|
| `fs:read` | `dasktop.fs.read` | `read_plugin_package_file` | 读取插件包自身目录内的文本文件 |
| `fs:write` | `dasktop.fs.write` | `write_plugin_package_file` | 写入插件包自身目录内的文本文件 |
| `log:write` | `dasktop.log.write` | `write_plugin_log` | 写入按插件隔离的日志 |
| `net:request` | `dasktop.net.request` | `plugin_http_request` | 发起 HTTP(S) 请求，**不受同源策略约束** |
| `ui:notify` | `dasktop.notify.send` | `notify_from_plugin` | 向宿主发送通知 |

这张表的「桥上方法」一列必须与 `bridge.js` 的 `CAPABILITY_TABLE` 一致；`verify-plugins.mjs`
解析后者、`verify-acl.mjs` 解析前者，两边不一致时校验会失败。

### 宿主侧日志与 `log:write` 的解耦

宿主在 `net:request` 前后、`notify.send` 时都会写日志，但走的是内部函数 `append_log`，
**不做权限判定**。要求插件为此声明 `log:write` 会把「能上网」和「能写日志」这两件事绑死，
一个只想发请求的插件被迫多申请一项它并不使用的能力。`append_log` 是宿主在记账，不是插件在调能力。

`net:request` 与浏览器 `fetch` 的差别正好说明了为什么值得单独开放这条能力：`fetch` 受同源策略
约束，而宿主代发的请求由 Rust 进程发出，没有 CORS 限制。

## 八、安全边界

| 边界 | 防护点 | 实现位置 |
|---|---|---|
| 命令调用（窗口级） | 插件窗口只被 `plugin` capability 覆盖，仅 5 条能力命令 | `permissions/` + `capabilities/` |
| 命令调用（插件级） | 每条能力用例第一行判该插件清单有没有声明该项 | `services/plugin::require_permission` |
| 调用方身份 | id 取自 `window.label()`（`plugin_<id>`），插件改不了；参数只作宿主窗口兜底 | `services/plugin::resolve_caller_plugin_id` |
| 桥脚本注入 | 插件身份经 `serde_json` 序列化，插件名里的引号逃不出配置字符串 | `services/plugin/bridge.rs` |
| 文件系统 | 协议处理器与 `fs:*` 复用同一套路径沙箱，页面资源与数据文件都不能逃出插件包目录 | `plugin_package::resolve_sandboxed_path` |
| 加载期预检 | 清单出现未知权限直接标记为不可用 | `plugin_package::load_package_record` |
| 入口缺失 | 扫描阶段就校验入口页面存在，不留到打开窗口时才 404 | `plugin_package::load_package_record` |
| 网络滥用 | 只允许 http/https；20 秒超时；响应体 2 MB 上限 | `infrastructure/http/` |
| 磁盘占用 | 单插件日志文件超过 512 KB 自动重置 | `plugin_log::reset_if_oversized` |
| 体积滥用 | 页面资源 8 MB、包内数据文件 4 MB 上限 | `domain/plugin/contract.rs` |

前四行是这套框架的**硬**边界。第一、二行由多个文件共同成立，动其中任何一个都要重新推一遍
（`pnpm verify:acl` + `pnpm verify:plugins` 覆盖）。

路径沙箱做两道独立校验，两道都需要，不能互相替代：

1. **形状校验**：拒绝绝对路径、盘符前缀、`..` 上跳、NTFS 数据流冒号（`file.txt:stream`）。
2. **落点校验**：对目标路径「已存在的最近祖先」做 `canonicalize` 后再比对是否仍在插件包内 ——
   形状校验识别不出符号链接与目录联接，一个指向 `C:\` 的 junction 就能让 `data/log.txt` 逃出沙箱。

## 九、能力扩展方式

给插件增加新能力（或给宿主加一条命令）的完整落点，**四处必须同步**：

1. **Rust 命令**：新增 `#[tauri::command]`（能力命令记得带 `window: Window` 参数），
   在 `lib.rs` 的 `invoke_handler` 注册；需要新依赖时同步 `Cargo.toml` 与 `Cargo.lock`。
2. **ACL（两层文件）**：
   - 宿主窗口要用的命令 → 加进 `permissions/host-commands.toml` 的 `commands.allow`；
   - 插件要用的命令 → 加进 `permissions/plugin-capabilities.toml`。
   **两处都漏了会表现为「命令在任何窗口都被拒」**，症状是「点了没反应 + 控制台报
   command not allowed」，且只在运行时暴露——`pnpm verify:acl` 专为这一步存在。
   放错文件则是另一类问题：放进 `plugin-capabilities.toml` 等于给插件窗口开了一条新能力。
3. **服务层编排**：`services/plugin/` 里加面向插件 id 的用例（**第一行 `require_permission`**）。
4. **桥（插件侧唯一的调用点）**：
   - `services/plugin/bridge.js`：在 `CAPABILITY_TABLE` 加一行映射，再按 `has(...)` 挂方法；
   - `entities/pluginPackage/permissions.ts`：加一条 `{ permission, command, summary }`；
   - `entities/pluginPackage/types.ts`：把新权限加进 `PLUGIN_PERMISSIONS`；
   - `domain/plugin/contract.rs`：加权限名常量并加进 `PLUGIN_PERMISSIONS`。
   四处不同步会被两个校验脚本抓住（`types.ts` ↔ `contract.rs` 的名字漂移、
   `bridge.js` ↔ `permissions.ts` 的方法漂移）。

已经走过的 `net:request` 留下一个值得记的坑：`reqwest` 0.13 的**默认特性会拉入
`aws-lc-sys`**，它在 Windows 上需要 cmake/nasm 做原生编译（本机两者都没有）。
解法是 `default-features = false` + `native-tls`（走系统 schannel，纯 FFI，没有原生编译步骤）。

## 十、当前框架的局限

- **插件页面是可信代码**。它跑在 WebView 里，有完整的 DOM、`window` 与网络访问能力，
  宿主对页面内部不做任何执行期限制。框架守的是「插件碰不到未授权能力」——这一条现在靠
  两层判定真正落实了——而不是「插件做不了坏事」。要更强的隔离只能上独立进程或独立
  WebView 分区。
- **`window.dasktop` 不是安全边界**。插件可以直接构造 `__TAURI_INTERNALS__.invoke(...)`。
  桥被绕过后宿主的判定照常生效，但「插件只能通过 dasktop 调」这类假设不成立。
- **ACL 的粒度是窗口而不是插件**（第一层）。所有插件窗口共享同一条 capability，做不出
  「插件 A 能调 X、插件 B 不能」——那个粒度由第二层（读清单）提供，但**第一层给的是同一份
  5 条命令**，即任何插件都能尝试调这 5 条，只是会被第二层按清单拒掉。
- **所有插件共享一个 origin**。`localStorage` 等存储是公用的，只能靠命名约定避免冲突。
  自定义协议的寻址形式由 WebView 决定（`<scheme>.localhost`），做不出「每插件一个 origin」。
- **页面资源没有 CSP**。`tauri.conf.json` 当前是 `"csp": null`，插件想加载什么外部资源都行。
  这是「插件即网页」的自然语义，但也意味着给插件窗口单独设 CSP 是个需要单独设计的事。
- **删掉 `src-tauri/permissions/` 会静默退回无门控**。应用照常启动、功能照常可用，插件页面
  却重新拿回全部能力，全程没有任何症状。这是这套设计最需要留意的脆弱点，也是
  `pnpm verify:acl` 第一条断言要挡的事。
- **无域名白名单**：`net:request` 只做权限门控，拿到权限的插件可以请求任意主机。
- **文本文件沙箱比文档更严格**：`fs:read` / `fs:write` 被限制在**插件包自身目录**内，
  而不是整个插件根目录 —— 允许插件 A 改写插件 B 的源码会让「重新加载」变成提权入口。
- **`fs:*` 只处理文本**。二进制读写（`ArrayBuffer`）尚未开放，桥上的两个方法都按字符串收发。
- **无签名校验**：当前不验证插件来源，生产环境应加签名机制。
- **无版本兼容检查**：只校验「未知权限」这一种不兼容，不校验插件声明的宿主版本要求。
- **通知不落库**：通知记录只在当前会话内存中保留最近 50 条，面板关闭重开后只剩日志文件里的历史。
- **示例包播种判据是「有无子目录」**：老用户的运行目录不会自动补写新示例包。每加一个内置
  示例包都要手动补给、或清空运行目录重播。手动补给时**必须带上新增的 `.js` 文件**，
  否则页面引用的 `./index.js` 会 404，窗口一片空白。

## 十一、开发与调试

```bash
# 路径沙箱、身份收敛与桥生成的回归测试
cargo test --lib --manifest-path src-tauri/Cargo.toml

# 插件包契约校验（含桥调用点 ↔ 清单权限核对）
pnpm verify:plugins

# 应用命令 ACL 校验（含两份 capability 的交集检查）
pnpm verify:acl

# 前端类型检查与构建
pnpm build
```

`pnpm verify:plugins` 值得单独说明：`plugins/` 目录完全不在 TypeScript 的覆盖范围内，
`vue-tsc` 与 `vite build` 都不会看它一眼。清单里文件名写错、页面里的相对链接指向不存在的
文件、声明了宿主不认识的权限、以及**用了没在清单里声明的桥能力**，构建阶段全都发现不了，
要等用户打开插件窗口才暴露。`scripts/verify-plugins.mjs` 把这些提到提交前：

- 清单可解析 / `id` 与目录名一致 / `entry` 存在且是 HTML；
- 包内每个 HTML/JS 的相对引用都指向真实文件、不以 `/` 开头、不是裸模块名，
  且**每个脚本文件都被引用过**（没被引用的脚本是死文件）；
- 插件的 `permissions` 都在 `PLUGIN_PERMISSIONS` 内（该集合从 `types.ts` 实时解析，
  并与 `contract.rs` 的常量比对，不另抄一份）；
- 插件源码里每个 `dasktop.xxx.yyy(...)` 调用的方法**存在**（对照 `bridge.js` 的
  `CAPABILITY_TABLE`），且对应权限**已在 `plugin.json` 声明**。

失败时定位到具体文件与调用点，例如：

```
- http-console：index.js 用到了 dasktop.net.request(...)，需要能力 net:request，
  但 plugin.json 的 permissions 里没有声明
- http-console：history.html 里的引用「/index.html」以 / 开头：绝对路径会被解析到协议根
  而不是插件目录，包内引用必须写成相对路径
```

`pnpm verify:acl` 盯的是一个**会静默失效**的机制：应用命令的鉴权只在 `src-tauri/permissions/`
有定义时才生效，而这个目录被删掉、或某条新命令忘了加进去，应用都能正常启动——前者让插件页面
重获全部能力（安全问题），后者让那条命令在宿主窗口里失效（功能问题），两者都不会在构建期报错。
`scripts/verify-acl.mjs` 逐条比对 `lib.rs` 的 `invoke_handler`、`permissions/*.toml` 与
`capabilities/*.json`，并断言：

1. 存在 app 权限定义（否则静默退回无门控）；
2. 每条注册命令都被某个 app 权限覆盖；
3. 权限里没有未注册的命令名（拼写错误，或删命令后忘了同步）；
4. 宿主窗口必须被 `default` capability 覆盖；
5. 插件窗口**不能**拿到宿主命令、**必须**拿到全部能力命令、**不能**超出 `permissions.ts`。

```
发现 2 个问题：
  - 命令「list_plugins」已注册但没有被任何 capability 授予：宿主窗口调用它会被拒。
  - app 权限里列了命令「list_plugns」，但它不在 lib.rs 的 invoke_handler 里。
```

调试时的几个落点：

- **插件列表里没有某个目录** → 检查是否为 `.` / `_` 前缀（扫描时跳过），或清单 `id` 与目录名不一致。
- **插件显示「不可用」** → 面板会直接给出原因：清单缺失、解析失败、入口页面不存在、未知权限。
- **点「打开」没反应** → 打开设置窗的开发者工具看 `console.error`，窗口创建失败只记日志、不弹提示。
- **窗口空白 + 宿主界面一起卡死** → 建窗命令被写成了同步 `fn`，主线程死锁。改回
  `async fn`（见「为什么建窗命令必须 `async`」）。判据：宿主设置页也冻住 = 主线程被占，
  纯空白则是另一回事（往下看资源 404）。
- **插件窗口一片空白** → 在插件窗口里右键打开开发者工具（dev 版可用），看是不是资源 404
  （常见于手动同步示例包时漏了 `.js` 文件）。也可以直接在浏览器里访问同路径排查。
- **`window.dasktop` 是 `undefined`** → 说明页面不是由宿主打开的，或这个包走了旧版建窗路径。
  确认 `open_plugin_window` 里挂了 `.initialization_script(...)`。
- **某个 `dasktop.xxx` 方法不存在** → 桥按清单逐项挂载，先看 `plugin.json` 的 `permissions`
  有没有声明对应权限；声明了还不行就核对 `CAPABILITY_TABLE`。
- **能力调用报权限错误** → 报「未声明权限」说明第二层拦住了，去 `plugin.json` 补声明；
  报 `command not allowed` 说明第一层拦住了，去 `plugin-capabilities.toml` 核对该命令在不在。
- **改了页面但窗口里还是旧的** → 关掉插件窗口重开。响应带 `no-store`，所以不存在缓存问题；
  窗口本身不会感知磁盘变化。
- **想查看插件输出** → 插件日志位于 `%APPDATA%\cn.syand.dasktop\plugin-logs\<plugin-id>.log`。
  页面自己的 `console.log` 在插件窗口的开发者工具里。

CSP 提示：当前 `"csp": null`，插件页面不受额外限制。如果后续开启全局 CSP，必须为
`connect-src`、`img-src`、`style-src` 等放行插件协议的前缀（Win 上是
`http://plugin.localhost`，其它平台是 `plugin://localhost`），否则插件页面会加载不出任何
自有资源。
