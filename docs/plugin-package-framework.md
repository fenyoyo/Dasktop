# 插件包框架

Dasktop 的可插拔包框架：插件以**磁盘上的插件包**形式存在，一个包就是一个目录，里面是一份
`plugin.json` 加若干网页文件。宿主扫描这些目录，把它们登记到「设置 → 插件」里；用户点「打开」
时，宿主开一个窗口，用自定义协议**把插件自己的页面加载进去**。

插件界面完全由插件作者掌控——任意 HTML、CSS、JS。宿主不拼界面、不审查 DOM、不执行插件代码。

与 `feat/plugin-system` 分支上的 uTools 式内置插件（Vue 组件编译进宿主、面向命令面板）
是两套并行机制：本框架面向「用户自己放进去的第三方网页」，关注的是**加载边界**。

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
│  │  ├ plugin_asset_base_url   │IPC│  ├ permissions 权限映射表     │  │
│  │  └ 能力命令（暂无调用方）    │   │  ├ api   URL 拼装 + invoke   │  │
│  │                            │   │  ├ loader 扫描 → 运行时记录   │  │
│  │ services/plugin/           │   │  └ window  插件窗口           │  │
│  │  ├ mod.rs   扫描/文件/通知  │   │                             │  │
│  │  └ protocol.rs ◄───────────┼───┼── plugin 协议处理器          │  │
│  │                            │   │                             │  │
│  │ infrastructure/            │   │ windows/settings/           │  │
│  │  ├ filesystem/plugin_pkg   │   │  └ panels/PluginsPanel.vue  │  │
│  │  ├ filesystem/plugin_log   │   │                             │  │
│  │  └ http/                   │   │                             │  │
│  └────────────────────────────┘   └─────────────────────────────┘  │
└───────────┬────────────────────────────────────┬───────────────────┘
            │ plugin 协议                         │ invoke
            │ http://plugin.localhost/<id>/…      │ （仅被 capability 覆盖的窗口）
            ▼                                    ▼
┌───────────────────────────────┐   ┌───────────────────────────────┐
│   插件窗口（每个插件一个）      │   │      设置窗口 / Box 窗口       │
│   label: plugin_<id>          │   │  被 capability 覆盖            │
│   加载插件作者写的网页          │   │  插件列表、打开入口            │
│   ✗ 不在任何 capability 内     │   └───────────────────────────────┘
│   ✗ 应用命令一律被 ACL 拒掉    │
└───────────────────────────────┘
```

一句话概括隔离模型：**应用命令必须经 capability 授予才可调用，而插件窗口不被任何
capability 覆盖。**

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

因此这套框架有两条**缺一不可**的防线：

1. `src-tauri/permissions/host-commands.toml` —— app 级权限定义，它的存在让应用命令进入鉴权；
2. `capabilities/default.json` 只覆盖 `main` / `box_*` / `box_menu` / `drag_preview`
   —— 插件窗口拿不到任何授予。

少了第一条，第二条形同虚设；少了第二条，插件窗口直接拿回全部能力。`pnpm verify:acl` 把这两条
都盯住（详见「开发与调试」）。

还有一处别想当然：`__TAURI_INTERNALS__` 的注入脚本是加在**每个** Tauri 创建的 webview 上的
（`manager/webview.rs`），插件页面**拿得到**调用入口。拦住它的是上面这套 ACL，
不是「拿不到入口」——写注释时按后者理解，会得出「只要不注入就没有风险」这种错误结论。

## 二、职责划分

### Rust 侧

| 模块 | 职责 |
|---|---|
| `commands/plugin.rs` | IPC 边界，只做参数接收与转发 |
| `services/plugin/mod.rs` | 解析插件根目录、编排扫描、包内文件访问、转发 HTTP、把通知落到 Tauri 事件 |
| `services/plugin/protocol.rs` | **`plugin` 协议处理器**：把 URL 解析成包内文件、推断 MIME、回状态码 |
| `infrastructure/filesystem/plugin_package.rs` | 目录扫描、清单解析、**包内路径沙箱**、资源读取、内置示例包播种 |
| `infrastructure/filesystem/plugin_log.rs` | 按插件分文件的日志追加与容量控制 |
| `infrastructure/http/` | HTTP 客户端：URL/方法校验、体积上限、响应头归一（对应 `net:request` 能力） |
| `domain/plugin/` | 契约常量、清单与扫描结果类型、网络请求/响应类型、内嵌示例包声明 |
| `permissions/host-commands.toml` | **app 级 ACL 定义**：把应用命令纳入鉴权，并（经 capability）授予宿主窗口。删掉它等于退回无门控，见「整体架构」 |
| `capabilities/default.json` | 授予宿主窗口代码能力；插件窗口刻意不在其中 |

### 前端侧

| 模块 | 职责 |
|---|---|
| `entities/pluginPackage/types.ts` | 传输契约与运行时视图两组类型、权限联合类型 |
| `entities/pluginPackage/permissions.ts` | **权限映射表**：权限字符串 → 宿主命令；加载期未知权限预检 |
| `entities/pluginPackage/api.ts` | `invoke` 封装与**插件页面 URL 拼装** |
| `entities/pluginPackage/loader.ts` | **加载器**：扫描 → 生成运行时记录；持有快照与通知订阅 |
| `entities/pluginPackage/window.ts` | 插件窗口的创建与复用（每插件一个窗口） |
| `entities/pluginPackage/index.ts` | 该领域的对外入口 |
| `shared/ipc/pluginPackage.ts` | 插件通知事件名与订阅 |
| `windows/settings/panels/PluginsPanel.vue` | 宿主面板：目录、可用状态、权限标签、通知流 |

对比此前版本，前端少掉了三块：`context.ts`（能力桥）、`worker/`（Worker 宿主与运行时）、
`windows/pluginHost/`（声明式界面渲染器）。它们存在的唯一理由是「插件被关在 Worker 里造不出
DOM」，页面模式下这个前提消失了。

## 三、插件包规格

```
<插件根目录>/
└── my-plugin/
    ├── plugin.json      # 必需：清单
    ├── index.html       # 必需：入口页面（由清单 entry 指定）
    ├── history.html     # 可选：想有几个页面就有几个
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

`entry` 指向的文件在**扫描阶段**就会校验存在性：少了这道校验，包能正常显示在设置页里，
直到用户点开窗口才看到一片空白，那时很难联想到是清单里文件名写错了。

### 页面怎么写

就是写网页。没有任何 SDK、没有必需的导出、没有生命周期函数——**宿主从不执行插件的代码**，
它只是把文件交给 WebView。

`plugins/hello-dasktop/index.html` 是最小示例，`plugins/http-console/index.html` +
`history.html` 演示两个页面之间的跳转。

几条实际会碰到的约束：

- **相对链接是唯一的包内寻址方式**。页面 URL 形如
  `http://plugin.localhost/my-plugin/index.html`，所以 `<a href="./history.html">` 会解析到
  同一个包里。而 `<a href="/history.html">` 会解析到**协议根**（`/history.html` 会被当成插件
  id），必然 404 —— 包内引用一律写相对路径。
- **所有插件共享同一个 origin**（`http://plugin.localhost`），因此 `localStorage`、
  `IndexedDB`、`sessionStorage` 是**公用**的。自己的 key 一定要带插件名前缀，
  否则会和别的插件互相覆盖。
- **`fetch` 受同源策略约束**。插件页面发起的请求需要目标接口返回 `Access-Control-Allow-Origin`。
  想访问不开放 CORS 的接口，得走宿主代发的路径（见「权限与能力」）。
- **深浅色跟随系统**，用 `prefers-color-scheme` 判断。插件页面在独立 WebView 里，
  跨窗口读不到宿主的主题设置。
- **`window.close()` 可用**：插件窗口是普通窗口，页面自己就能关掉自己。

## 四、资源协议

插件页面的 URL 前缀**不跨平台一致**：Windows（WebView2）与 Android 把它映射成
`http://plugin.localhost`，其余平台是 `plugin://localhost`。这条判断只放在 Rust 侧一处
（`services/plugin::asset_base_url`），前端通过 `plugin_asset_base_url` 命令取回并缓存，
再拼上 `/<插件id>/<相对路径>`。

URL 必须是**多段**形式。前端拼装时逐段 `encodeURIComponent` 而不是整串编码
（`encodeURIComponent` 会把 `/` 一起编成 `%2F`，把多段路径压成一段），否则页面里的
相对链接会丢掉插件 id —— 这是最容易踩的一个坑，`api.ts` 里专门写了注释挡住它。

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

## 五、加载流程

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
   ├─► resolvePluginPageUrl() 取 URL 前缀（首次走 IPC，之后缓存）+ 拼相对路径
   ├─► 该插件的窗口已存在 → 直接聚焦，不重新导航（否则会把翻到第二页的用户弹回入口）
   └─► 不存在 → 建窗口 label: plugin_<id>，url 指向入口页面
```

关键点：

- **加载器不执行插件代码，也没有「卸载」**。它只把磁盘扫成一份可展示的记录，插件窗口的生命
  周期跟宿主这边没有交集，因此没有需要回收的资源。
- **单个插件失败不影响其它插件，也不中断宿主启动**。所有失败都收敛成记录里的 `error` 字段，
  设置页的 `onMounted` 对扫描也不做 `await`。
- **可用状态只有两种**（`ready` / `failed`）。页面模式下插件不需要被「激活」，用
  「已加载」会让人误以为宿主已经把插件代码跑起来了。

## 六、权限与能力

这里有**两个不同的东西**共用「权限」这个词，混着看会得出错误结论，先分开。

### A. ACL 门控：哪个窗口能调命令

由 `src-tauri/permissions/host-commands.toml`（定义）+ `capabilities/default.json`（授予）
组成，是运行期真正生效的那一层。结论一句话：**宿主窗口能调全部应用命令，插件窗口一条都调不了。**
注意它的粒度是**窗口**而不是插件——它不是「插件被允许调什么」，而是「窗口被允许调什么」。

### B. 权限映射表：插件清单声明的能力

`permissions.ts` 描述的是「权限 → 宿主命令」：

| 权限 | 对应宿主命令 | 说明 |
|---|---|---|
| `fs:read` | `read_plugin_package_file` | 读取插件包自身目录内的文本文件 |
| `fs:write` | `write_plugin_package_file` | 写入插件包自身目录内的文本文件 |
| `log:write` | `write_plugin_log` | 写入按插件隔离的日志 |
| `net:request` | `plugin_http_request` | 发起 HTTP(S) 请求，**不受同源策略约束** |
| `ui:notify` | `notify_from_plugin` | 向宿主发送通知 |

**当前状态：这张表还没有接线。** 这些命令没有调用方，清单里声明 `permissions` 目前只影响
「未知权限预检」这一件事（声明了宿主不认识的权限则该包被标记为不可用）。保留整套能力实现是
有意为之——受控桥落地时它才真正生效。

### 受控桥（尚未落地）需要先定的两件事

下一步是让插件窗口能调一部分能力，而**可靠的落点只有 ACL**：

- 插件页面总能绕过任何注入进去的便利对象（`window.dasktop` 之类），直接构造一次
  `window.__TAURI_INTERNALS__.invoke(…)`。所以「注入的桥自己做权限检查」不成立，
  真正的判据只能是 ACL，或宿主收到的请求本身；
- 清单里的 `permissions` 是**按插件**声明的，而 capability 是**按窗口**静态授予的，
  两者粒度对不上。接起来要么走上 Tauri 的 `dynamic-acl`（按清单为窗口动态加 capability），
  要么把落点收进命令内部（每条命令自己确认调用方是哪个插件、授权集合是什么）。这是动工前
  要先拍板的事。

`net:request` 与浏览器 `fetch` 的差别正好说明了为什么值得保留这条路径：`fetch` 受同源策略
约束，而宿主代发的请求由 Rust 进程发出，没有 CORS 限制。

## 七、安全边界

| 边界 | 防护点 | 实现位置 |
|---|---|---|
| 命令调用 | 应用命令经 app ACL 鉴权；插件窗口不被任何 capability 覆盖 | `permissions/host-commands.toml` + `capabilities/default.json` |
| 文件系统 | 协议处理器复用 `fs` 的路径沙箱，页面资源不能逃出插件包目录 | `plugin_package::resolve_sandboxed_path` |
| 加载期预检 | 清单出现未知权限直接标记为不可用 | `loader::describePackage` |
| 入口缺失 | 扫描阶段就校验入口页面存在，不留到打开窗口时才 404 | `plugin_package::load_package_record` |
| 网络滥用 | 只允许 http/https；20 秒超时；响应体 2 MB 上限 | `infrastructure/http/` |
| 磁盘占用 | 单插件日志文件超过 512 KB 自动重置 | `plugin_log::reset_if_oversized` |
| 体积滥用 | 页面资源 8 MB、包内数据文件 4 MB 上限 | `domain/plugin/contract.rs` |

第一行是这套框架唯一的**硬**边界，其余几行属于「用起来更安全」的约束。它由两条配置共同成立，
动其中任何一条都要重新推一遍（`pnpm verify:acl` 挡住最容易犯的两种错：漏加命令、以及有人
图省事把 `plugin_*` 写进 capability 的窗口模式）。

路径沙箱做两道独立校验，两道都需要，不能互相替代：

1. **形状校验**：拒绝绝对路径、盘符前缀、`..` 上跳、NTFS 数据流冒号（`file.txt:stream`）。
2. **落点校验**：对目标路径「已存在的最近祖先」做 `canonicalize` 后再比对是否仍在插件包内 ——
   形状校验识别不出符号链接与目录联接，一个指向 `C:\` 的 junction 就能让 `data/log.txt` 逃出沙箱。

## 八、能力扩展方式

给插件增加新能力（或给宿主加一条命令）的完整落点：

1. **Rust 命令**：新增 `#[tauri::command]`，在 `lib.rs` 的 `invoke_handler` 注册；
   需要新依赖时同步 `Cargo.toml` 与 `Cargo.lock`。
2. **`permissions/host-commands.toml`**：把命令名加进 `allow-host-commands` 的
   `commands.allow`。**漏了这一步，命令在宿主窗口里也会被拒**，症状是「点了没反应 +
   控制台报 command not allowed」，且只在运行时暴露——`pnpm verify:acl` 专为这一步存在。
3. **`services/plugin/`**：把命令包装成面向插件 id 的用例（校验 id、记日志、编排副作用）。
4. **`entities/pluginPackage/api.ts`**：加 `invoke` 封装。
5. **`entities/pluginPackage/types.ts`**：扩 `PLUGIN_PERMISSIONS` 与相关传输类型。
6. **`entities/pluginPackage/permissions.ts`**：加一条 `{ command, permission, summary }` 映射，
   面板上的权限标签读它（`scripts/verify-plugins.mjs` 也实时解析 `PLUGIN_PERMISSIONS` 校验
   示例插件，所以它无需同步）。
7. **受控桥**（尚未落地）：让插件窗口真正调得到这条能力，落点与前置决策见「权限与能力」。

已经走过的 `net:request` 留下一个值得记的坑：`reqwest` 0.13 的**默认特性会拉入
`aws-lc-sys`**，它在 Windows 上需要 cmake/nasm 做原生编译（本机两者都没有）。
解法是 `default-features = false` + `native-tls`（走系统 schannel，纯 FFI，没有原生编译步骤）。

## 九、当前框架的局限

- **插件页面是可信代码**。它跑在 WebView 里，有完整的 DOM、`window` 与网络访问能力，
  宿主对页面内部不做任何执行期限制。框架守的是「插件碰不到宿主能力」——这一条现在靠 ACL
  真正落实了——而不是「插件做不了坏事」。要更强的隔离只能上独立进程或独立 WebView 分区。
- **所有插件共享一个 origin**。`localStorage` 等存储是公用的，只能靠命名约定避免冲突。
  自定义协议的寻址形式由 WebView 决定（`<scheme>.localhost`），做不出「每插件一个 origin」。
- **页面资源没有 CSP**。`tauri.conf.json` 当前是 `"csp": null`，插件想加载什么外部资源都行。
  这是「插件即网页」的自然语义，但也意味着给插件窗口单独设 CSP 是个需要单独设计的事。
- **清单里的 `permissions` 目前不生效**。ACL 那一层已经生效（插件窗口确实一条命令都调不了），
  但「按清单声明逐项放开」要等受控桥；两者是两回事，见「权限与能力」。
- **ACL 的粒度是窗口而不是插件**。所有插件窗口共享同一条策略，做不出「插件 A 能调 X、
  插件 B 不能」。要那个粒度只能走 `dynamic-acl`，或把判定收进命令内部。
- **删掉 `src-tauri/permissions/` 会静默退回无门控**。应用照常启动、功能照常可用，插件页面
  却重新拿回全部能力，全程没有任何症状。这是这套设计最需要留意的脆弱点，也是
  `pnpm verify:acl` 第一条断言要挡的事。
- **无域名白名单**：`net:request` 只做权限门控，拿到权限的插件可以请求任意主机。
- **文本文件沙箱比文档更严格**：`fs:read` / `fs:write` 被限制在**插件包自身目录**内，
  而不是整个插件根目录 —— 允许插件 A 改写插件 B 的源码会让「重新加载」变成提权入口。
- **无签名校验**：当前不验证插件来源，生产环境应加签名机制。
- **无版本兼容检查**：只校验「未知权限」这一种不兼容，不校验插件声明的宿主版本要求。
- **通知不落库**：通知记录只在当前会话内存中保留最近 50 条，面板关闭重开后只剩日志文件里的历史。

## 十、开发与调试

```bash
# 路径沙箱与协议解析的回归测试
cargo test --lib --manifest-path src-tauri/Cargo.toml

# 插件包契约校验
pnpm verify:plugins

# 应用命令 ACL 校验
pnpm verify:acl

# 前端类型检查与构建
pnpm build
```

`pnpm verify:plugins` 值得单独说明：`plugins/` 目录完全不在 TypeScript 的覆盖范围内，
`vue-tsc` 与 `vite build` 都不会看它一眼。清单里文件名写错、页面里的相对链接指向不存在的
文件、声明了宿主不认识的权限，构建阶段全都发现不了，要等用户打开插件窗口才暴露。
`scripts/verify-plugins.mjs` 把这几类检查提到提交前，失败时定位到具体页面与引用：

```
- http-console：index.html 里的引用「./historys.html」指向不存在的文件
- http-console：history.html 里的引用「/index.html」以 / 开头：绝对路径会被解析到协议根
  而不是插件目录，包内引用必须写成相对路径
```

`pnpm verify:acl` 同理值得单独说明，它盯的是一个**会静默失效**的机制：应用命令的鉴权只在
`src-tauri/permissions/` 有定义时才生效，而这个目录被删掉、或某条新命令忘了加进去，应用都能
正常启动——前者让插件页面重获全部能力（安全问题），后者让那条命令在宿主窗口里失效（功能问题），
两者都不会在构建期报错。`scripts/verify-acl.mjs` 逐条比对 `lib.rs` 的 `invoke_handler`、
`permissions/*.toml` 与 `capabilities/*.json`，并断言没有任何 capability 覆盖插件窗口：

```
发现 2 个问题：
  - 命令「list_plugins」已注册但没有被任何 capability 授予：宿主窗口调用它会被拒。把它加进 src-tauri/permissions/host-commands.toml
  - app 权限里列了命令「list_plugns」，但它不在 lib.rs 的 invoke_handler 里（拼写错误，或删命令后忘了同步权限文件）
```

调试时的几个落点：

- **插件列表里没有某个目录** → 检查是否为 `.` / `_` 前缀（扫描时跳过），或清单 `id` 与目录名不一致。
- **插件显示「不可用」** → 面板会直接给出原因：清单缺失、解析失败、入口页面不存在、未知权限。
- **点「打开」没反应** → 打开设置窗的开发者工具看 `console.error`，窗口创建失败只记日志、不弹提示。
- **插件窗口一片空白** → 在插件窗口里右键打开开发者工具（dev 版可用），看是不是资源 404。
  也可以直接在浏览器里访问同路径排查。
- **想确认插件窗口真的调不动宿主命令** → 在插件窗口的开发者工具里执行
  `await window.__TAURI_INTERNALS__.invoke("list_plugins")`，报 `command not allowed` 才是
  预期结果。若真的返回了插件列表，说明 ACL 没生效：先看 `src-tauri/permissions/` 还在不在，
  再看 `capabilities/default.json` 的窗口列表有没有被人写进 `plugin_*`。
- **改了页面但窗口里还是旧的** → 关掉插件窗口重开。响应带 `no-store`，所以不存在缓存问题；
  窗口本身不会感知磁盘变化。
- **想查看插件输出** → 插件日志位于 `%APPDATA%\cn.syand.dasktop\plugin-logs\<plugin-id>.log`。
  页面自己的 `console.log` 在插件窗口的开发者工具里。

CSP 提示：当前 `"csp": null`，插件页面不受额外限制。如果后续开启全局 CSP，必须为
`connect-src`、`img-src`、`style-src` 等放行插件协议的前缀（Win 上是
`http://plugin.localhost`，其它平台是 `plugin://localhost`），否则插件页面会加载不出任何
自有资源。
