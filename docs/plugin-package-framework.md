# 插件包框架

Dasktop 的可插拔包框架：插件以**磁盘上的插件包**形式存在，由宿主在启动时扫描、读取源码，
在**独立 Web Worker** 中激活。插件源码是标准 ESM 脚本，宿主不替它做任何代码转换。

与 `feat/plugin-system` 分支上的 uTools 式内置插件（Vue 组件编译进宿主、面向命令面板）
是两套并行的机制：本框架面向「用户自己放进去的第三方脚本」，关注的是**沙箱边界**，
因此入口是纯 JS 文件而不是 Vue 组件。

## 一、整体架构

```
┌──────────────────────────────────────────────────────────────────┐
│                        宿主程序（Tauri App）                       │
│                                                                  │
│  ┌───────────────────┐        ┌────────────────────────────┐     │
│  │      Rust 侧      │        │          前端侧             │     │
│  │                   │        │                            │     │
│  │ commands/plugin   │◄──────►│ entities/pluginPackage     │     │
│  │  ├ list_plugins   │  IPC   │  ├ permissions 权限映射表   │     │
│  │  ├ read_plugin_*  │        │  ├ context 主线程能力桥     │     │
│  │  └ 宿主能力命令    │        │  ├ loader  扫描+激活+界面树 │     │
│  │                   │        │  ├ window  插件宿主窗口     │     │
│  │ services/plugin   │        │  └ worker/                 │     │
│  │ infrastructure/   │        │      ├ host.ts Worker 宿主  │     │
│  │  filesystem/      │        │      └ runtime.js Worker 侧 │     │
│  │   plugin_package  │        │                            │     │
│  │   plugin_log      │        │ windows/pluginHost/        │     │
│  │  http/            │        │  ├ index.vue   宿主窗口页   │     │
│  │   mod.rs reqwest  │        │  └ UiNodeRenderer.vue 渲染器 │     │
│  └───────────────────┘        └────────────────────────────┘     │
│                                   │              ▲               │
│                    结构化克隆消息  │              │ Tauri 事件     │
│                    （rpc / ui）    ▼              │（界面树/交互）  │
│  ┌──────────────────────────────────────────┐    │               │
│  │        Web Worker（每个插件一个）          │    │               │
│  │  runtime.js 运行时 + 插件 index.js        │    │               │
│  │  ✗ window  ✗ document  ✗ Tauri 注入对象   │    │               │
│  └──────────────────────────────────────────┘    │               │
└──────────────────────────────────────────────────┼───────────────┘
                                                    │
                          ┌─────────────────────────┴──────────┐
                          │   插件宿主窗口（独立 WebView）       │
                          │   label: plugin_host               │
                          │   渲染界面树 → 点击 → 事件回传      │
                          └────────────────────────────────────┘
```

两处隔离值得单独指出：

- **插件跑在 Worker 里**，拿不到 `window`、`document`，也拿不到 Tauri 注入到页面的对象。
  插件死循环不会再卡住宿主 UI。
- **插件界面跑在独立窗口里**，而插件自己在另一个窗口的 Worker 里。Tauri 每个窗口是独立
  JS 环境，两者之间**没有共享内存**，界面树与交互只能走 Tauri 事件通道。

## 二、职责划分

### Rust 侧

| 模块 | 职责 |
|---|---|
| `commands/plugin.rs` | IPC 边界，只做参数接收与转发，不做权限判断 |
| `services/plugin/` | 解析插件根目录、编排扫描与包内文件访问、转发 HTTP、把通知落到 Tauri 事件 |
| `infrastructure/filesystem/plugin_package.rs` | 目录扫描、清单解析、**包内路径沙箱**、内置示例包播种 |
| `infrastructure/filesystem/plugin_log.rs` | 按插件分文件的日志追加与容量控制 |
| `infrastructure/http/` | `net:request` 的 HTTP 客户端：URL/方法校验、体积上限、响应头归一 |
| `domain/plugin/` | 契约常量、清单与扫描结果类型、网络请求/响应类型、内嵌示例包源码 |

补一条关键约定：**能力命令本身不做权限判断**。宿主能力扩展只需在后端加一个命令，
权限的裁剪与二次校验全部由前端承担，两边不会各维护一套判断逻辑。

### 前端侧

| 模块 | 职责 |
|---|---|
| `entities/pluginPackage/types.ts` | 传输契约、Worker 消息协议、声明式 UI 协议、运行时视图四组类型 |
| `entities/pluginPackage/permissions.ts` | **权限映射表**：权限字符串 → 宿主能力描述；加载期预检与运行期二次校验 |
| `entities/pluginPackage/context.ts` | **主线程能力桥**：权限校验唯一真正生效的地方，含入参形状校验 |
| `entities/pluginPackage/worker/host.ts` | **Worker 宿主**：建 Worker、路由消息、生命周期与超时 |
| `entities/pluginPackage/worker/runtime.js` | **Worker 侧运行时**：与插件源码拼接，按权限裁剪 `host`、驱动插件生命周期 |
| `entities/pluginPackage/loader.ts` | **加载器**：扫描 → 读源码 → 起 Worker → 激活；管理已加载表、界面树与四类事件订阅 |
| `entities/pluginPackage/window.ts` | 插件宿主窗口的创建、复用与切换 |
| `entities/pluginPackage/api.ts` | 宿主命令的 `invoke` 封装（不导出给插件） |
| `shared/ipc/pluginPackage.ts` | 五组插件事件名与订阅 |
| `windows/pluginHost/index.vue` | 插件宿主窗口页：订阅界面树、转发交互 |
| `windows/pluginHost/components/UiNodeRenderer.vue` | 声明式界面树的递归渲染器 |
| `windows/settings/panels/PluginsPanel.vue` | 宿主面板：目录、加载状态、权限标签、通知流 |

## 三、插件包规格

一个插件包是一个目录，放在插件根目录下：

```
<插件根目录>/
└── my-plugin/
    ├── plugin.json      # 必需：清单
    ├── index.js         # 必需：入口源码（ESM）
    └── ...              # 可选：插件自有数据文件
```

插件根目录位于应用数据目录：`%APPDATA%\cn.syand.dasktop\plugins`，
可在「设置 → 插件」中直接打开。目录下没有任何子目录时，宿主会写入仓库内
`plugins/` 下**全部**内置示例包（当前两个）。

### 清单字段

| 字段 | 说明 |
|---|---|
| `id` | 插件唯一标识，**必须与插件包目录名一致**，否则该包被标记为无效 |
| `name` | 展示名称 |
| `version` | 插件版本号 |
| `entry` | 入口文件相对路径，只允许包内相对路径 |
| `permissions` | 声明需要的能力列表 |

### 入口文件约定

- 必须导出 `activate(host)`，宿主加载时调用；可以返回 Promise，宿主会等待其完成。
- 可选导出 `deactivate(host)`，卸载时调用。
- 可选导出 `onUiEvent(action, payload)`，消费界面交互；**只有声明了 `ui:panel` 的插件
  才需要它**。
- **禁止直接 import 任何 Tauri API**，能力只能从 `host` 参数获取。
- 单一文件入口，不支持包内相对 `import`：源码与运行时拼接后交给原生 `import`，
  相对路径无法在 blob 协议下解析。需要读包内资源时用 `host.fs.read`。

运行在 Worker 里带来两条硬约束，写插件时必须心里有数：

1. **没有 `window` / `document` / DOM**，不能自己操作界面——界面只能靠**下发描述树**。
2. **不能自己发起 `fetch`**：Worker 里虽然存在 `fetch`，但宿主希望网络请求统一受
   `net:request` 权限与体积/超时约束，框架的示例与文档都以 `host.net.request` 为准。

最小示例（仓库内 `plugins/hello-dasktop/`）：

```js
export async function activate(host) {
  await host.log?.write("已激活");

  // 权限是按方法裁剪的：只声明 fs:write 时读不到 host.fs.read
  if (host.fs?.write) {
    await host.fs.write("state.json", JSON.stringify({ at: Date.now() }));
  }

  await host.notify?.("Hello Dasktop", "插件已激活");
}

export async function deactivate(host) {
  await host.log?.write("已卸载");
}
```

带界面的示例见 `plugins/http-console/`：它把 `net:request`、`ui:panel`、`fs:read/write`
三种能力串成一条端到端链路（输入地址 → 发请求 → 展示结果 → 落盘历史）。

### 声明式 UI 协议

插件**不能**自己造 DOM，只能下发一棵**可序列化的纯数据树**，由宿主渲染器翻译成真实元素。

```js
host.ui.render({
  type: "stack", direction: "column", gap: "md",
  children: [
    { type: "text", value: "输入地址后发送请求", tone: "muted" },
    { type: "input", action: "setUrl", label: "请求地址", value: state.url },
    { type: "button", action: "send", label: "发送请求", tone: "primary" },
    { type: "card", title: "结果", children: [
      { type: "key-value", entries: [{ key: "状态", value: "200" }] },
    ]},
  ],
});
```

| 节点 | 必需字段 | 可选字段 |
|---|---|---|
| `text` | `value: string` | `tone: muted / normal / strong` |
| `button` | `action: string`、`label: string` | `tone: danger / default / primary` |
| `input` | `action: string` | `label`、`placeholder`、`value` |
| `stack` | `children: Node[]`、`direction: column / row` | `gap: lg / md / none / sm` |
| `card` | `children: Node[]` | `title` |
| `list` | `items: string[]` | — |
| `key-value` | `entries: { key, value }[]` | — |

协议有意收得很紧，正是安全性的来源：

- **没有 HTML 字符串、没有内联样式、没有事件属性**，插件无法把 `<script>` 或 `onclick`
  送进宿主页面；
- `tone` / `gap` / `direction` 是**枚举档位**而不是任意数值，界面观感不会被插件破坏；
- 交互只能通过节点上的 `action` 字符串回传，宿主把 `onUiEvent(action, payload)` 交给插件，
  由插件自己决定怎么响应。

两点实现细节：

- **`input` 只在提交时（回车或失焦）回传**，不是每次按键都回传。逐键往返会让插件重渲染
  整棵树，输入框随之重建、光标位置也会丢。
- **界面是整树下发**，没有增量补丁。`render()` 收到的一定是完整的一帧，插件无需维护
  差异状态；代价是节点多时消息体偏大，对「一屏参数面板」级别的界面不构成问题。

## 四、加载流程

```
1. 设置页根组件挂载
   └─► initializePluginRuntime()（幂等，共享同一个 Promise）
       ├─► 订阅：通知 / 宿主窗口就绪 / 界面交互转发
       └─► list_plugins 扫描插件根目录
           （目录不存在则创建；目录下无子目录时写入全部内置示例包）

2. 对每个插件包（串行）
   ├─► 清单不可解析 / id 与目录名不一致 → 记为「加载失败」并继续下一个
   ├─► 权限预检：出现宿主不认识的权限 → 拒绝加载并记录缺失的权限
   ├─► read_plugin_entry 读取入口源码
   ├─► 拼接 runtime.js + 插件源码 → Blob → module worker
   ├─► postMessage({ kind: "init", config }) → 等 activated / error
   │   （10 秒未结算 → 终止 Worker，记为加载失败）
   └─► 只有拿到 activated 才把 Worker 放进已激活表

3. 界面显示（用户点插件卡片上的「界面」按钮）
   ├─► openPluginHostWindow()：无窗口则建，有窗口则 setTitle + 发切换事件
   ├─► 窗口 onMounted 后广播 plugin-host-ready 报到
   └─► 插件运行时所在窗口收到报到，回发一次当前界面树
```

关键点：

- **单个插件失败不影响其它插件，也不中断宿主启动**。所有失败都收敛成运行时记录里的
  `error` 字段，设置页的 `onMounted` 对插件加载也不做 `await`。
- **界面树走「就绪握手」而不是「创建后直接补发」**。刚建好的窗口里监听器未必已注册，
  补发的事件可能早于监听而丢失；改由窗口主动报到，时序从「猜」变成「确定」。
- **交互要绕一圈事件**才能送到插件手上：点击发生在插件宿主窗口，而 Worker 活在设置窗口。
  完整路径是 `宿主窗口 → emitPluginUiEvent → 设置窗口 loader → worker.sendUiEvent → 插件`。

## 五、权限表

| 权限 | 暴露位置 | 对应宿主命令 | 说明 |
|---|---|---|---|
| `fs:read` | `host.fs.read(relativePath)` | `read_plugin_package_file` | 读取插件包自身目录内的文本文件 |
| `fs:write` | `host.fs.write(relativePath, contents)` | `write_plugin_package_file` | 写入插件包自身目录内的文本文件 |
| `log:write` | `host.log.write/info/error` | `write_plugin_log` | 写入按插件隔离的日志 |
| `net:request` | `host.net.request({ url, method?, headers?, body? })` | `plugin_http_request` | 发起 HTTP(S) 请求 |
| `ui:notify` | `host.notify(title, message)` | `notify_from_plugin` | 向宿主发送通知 |
| `ui:panel` | `host.ui.render(tree)` | 无（走 Tauri 事件） | 下发界面描述，由宿主渲染到插件宿主窗口 |

权限在**两处**同时生效，两处都需要，不能互相替代：

1. **Worker 侧的裁剪**（`runtime.js`）：未声明的能力，`host` 上根本没有对应成员，
   插件在开发阶段就能通过 `host.fs?.read` 这类判定发现自己漏声明了权限。
2. **主线程侧的校验**（`context.ts`）：每次 RPC 都按方法名重新查授权集合。Worker 里
   是插件自己的代码，它换掉 `host`、直接 `postMessage` 一条伪造 RPC 都是允许的，
   所以真正的判据只能在这里。

## 六、安全边界

| 边界 | 防护点 | 实现位置 |
|---|---|---|
| 进程内隔离 | 插件在独立 Worker，无 `window`/`document`/Tauri 注入对象 | `worker/host.ts` |
| 插件死循环 | 激活 10 秒 / 卸载 3 秒未结算即终止 Worker | `worker/host.ts` |
| 命令调用 | 插件拿不到原始 `invoke`，只能走消息通道的 `rpc` 分支 | `worker/host.ts` |
| 权限（Worker 侧） | 未声明的能力，`host` 上不提供对应方法 | `worker/runtime.js` |
| 权限（主线程侧） | 每条 RPC 按方法名再校验一次授权集合 | `context.ts` |
| 入参形状 | RPC 参数按不可信输入校验，HTTP 请求只挑已知字段 | `context.ts` |
| 界面伪造 | `ui-render` 消息再次校验 `ui:panel`，越权**静默丢弃** | `worker/host.ts` |
| 文件系统 | 插件包目录之外的文件访问被拦截 | `plugin_package::resolve_sandboxed_path` |
| 加载期预检 | 清单出现未知权限直接拒绝加载 | `loader::activatePluginPackage` |
| 网络滥用 | 只允许 http/https；20 秒超时；响应体 2 MB 上限 | `infrastructure/http/` |
| 磁盘占用 | 单插件日志文件超过 512 KB 自动重置 | `plugin_log::reset_if_oversized` |
| 体积滥用 | 入口源码 2 MB、包内数据文件 4 MB 上限 | `domain/plugin/contract.rs` |

路径沙箱做两道独立校验，两道都需要，不能互相替代：

1. **形状校验**：拒绝绝对路径、盘符前缀、`..` 上跳、NTFS 数据流冒号（`file.txt:stream`）。
2. **落点校验**：对目标路径「已存在的最近祖先」做 `canonicalize` 后再比对是否仍在插件包内——
   形状校验识别不出符号链接与目录联接，一个指向 `C:\` 的 junction 就能让 `data/log.txt` 逃出沙箱。

关于 Worker 隔离的**真实边界**，不要高估它：Worker 是同一渲染进程内的线程而非独立进程，
它防的是「插件拿到宿主对象」与「插件卡死 UI」，**不防** CPU 抢占、内存滥用与进程级崩溃。
真正的进程级隔离需要把插件放到独立进程或独立 WebView 里，属于后续演进方向。

## 七、能力扩展方式

宿主想给插件增加新能力，完整落点如下（`net:request` 与 `ui:panel` 就是按这套流程加进来的）：

1. **Rust 命令**：新增 `#[tauri::command]`，在 `lib.rs` 的 `invoke_handler` 注册；
   需要新依赖时同步 `Cargo.toml` 与 `Cargo.lock`。
2. **`entities/pluginPackage/api.ts`**：加一个 `invoke` 封装，把 camelCase 参数与
   命令签名对齐。
3. **`entities/pluginPackage/context.ts`**：在桥的 `switch (method)` 里加分支，
   **先 `assertPluginPermission`，再校验入参形状**。
4. **`entities/pluginPackage/types.ts`**：扩 `PLUGIN_PERMISSIONS` 联合类型、
   `PluginHostApi` 上的成员类型、以及需要时的 Worker 消息协议。
5. **`entities/pluginPackage/permissions.ts`**：加一条
   `{ hostMember, permission, summary }` 映射记录，面板上的权限标签与加载期预检都读它。
6. **`entities/pluginPackage/worker/runtime.js`**：按新权限裁剪出对应方法，
   让它出现在插件的 `host` 上。
7. **`scripts/verify-plugins.mjs`**：同步 `KNOWN_PERMISSIONS` 与 `METHOD_PERMISSION`，
   否则合法清单会被契约脚本误判成非法。

插件作者只需在清单里声明对应权限，就能通过 `host` 调用新能力。
**无需修改加载器，无需重新设计协议。**

以已落地的 `net:request` 为例：后端新增 `plugin_http_request` 命令
（`reqwest` 0.13，**刻意 `default-features = false` + `native-tls`**——默认特性会拉入
`aws-lc-sys`，在 Windows 上需要 cmake/nasm 做原生编译），桥里加 `net.request` 分支，
`host.net.request(...)` 即可用。

## 八、当前框架的局限

- **Worker 不是进程**：同一渲染进程内的线程，只隔离了对象可达性与 UI 阻塞，
  不隔离 CPU / 内存 / 崩溃。见「安全边界」末段。
- **无域名白名单**：`net:request` 只做权限门控，拿到权限的插件可以请求任意主机。
  对「用户自己写给自己用的脚本」这一目标用户是合理取舍，但面向插件分发的场景需要补。
- **界面表达力有限**：只有 7 种节点，没有表格、下拉框、图片，也不支持自定义样式。
  这是刻意的——每加一种节点就多一块需要渲染器守住的面。
- **界面整树下发**：没有增量补丁，节点很多时每帧的消息体偏大。
- **界面窗口是同一个宿主**：所有插件共用一个 `plugin_host` 窗口，同时只能看一个插件的界面；
  切换会替换内容，插件自己的界面滚动位置等瞬时状态不保留。
- **文本文件沙箱比文档更严格**：`fs:read` / `fs:write` 被限制在**插件包自身目录**内，
  而不是整个插件根目录——允许插件 A 改写插件 B 的源码会让「重新加载」变成提权入口。
- **无签名校验**：当前不验证插件来源，生产环境应加签名机制。
- **无版本兼容检查**：只校验「未知权限」这一种不兼容，不校验插件声明的宿主版本要求。
- **通知不落库**：`ui:notify` 的记录只在当前会话内存中保留最近 50 条，
  面板关闭重开后只剩日志文件里的历史。

以上局限都可以在框架不变的前提下逐项加固，属于后续演进方向。

## 九、开发与调试

```bash
# 路径沙箱回归测试（读写越权、id 白名单、示例包播种）
cargo test --lib --manifest-path src-tauri/Cargo.toml

# 插件契约校验（导出契约 / 能力门控 / 界面协议）
pnpm verify:plugins

# 前端类型检查与构建
pnpm build
```

`pnpm verify:plugins` 值得单独说明：插件入口是以**字符串**交给 Worker 的，
`vue-tsc` 与 `vite build` 对 `plugins/` 目录**零覆盖**——改坏一个导出名或写错一个界面
字段，构建照样通过，只有运行时才发现。`scripts/verify-plugins.mjs` 在 Node 里用真实的
`runtime.js` 复刻宿主环境跑一遍，能定位到具体节点：

```
- http-console：激活帧.children[0].tone 取值 "faint" 不在 muted / normal / strong 内
```

调试插件时的几个落点：

- 插件列表不显示某目录 → 检查是否为 `.`/`_` 前缀（扫描时跳过），或清单 `id` 与目录名不一致。
- 插件显示「加载失败」→ 面板会直接给出原因：清单缺失、解析失败、未知权限、
  `activate` 抛错，或「激活超过 10 秒未完成」（多半是插件里有死循环）。
- 插件界面窗口空白 → 检查清单是否声明了 `ui:panel`；声明了但没画面，
  说明插件没有调用 `host.ui.render(...)`。
- 界面上的按钮或输入框没反应 → 插件没有导出 `onUiEvent`。
- 想查看插件输出 → 插件日志位于 `%APPDATA%\cn.syand.dasktop\plugin-logs\<plugin-id>.log`。
- 修改插件源码后需要在「设置 → 插件」点「重新加载」：已启动的 Worker 不会感知磁盘变化。

CSP 提示：插件 Worker 由 Blob URL 构造，`tauri.conf.json` 当前是 `"csp": null`，
blob 脚本不受额外限制。如果后续开启 CSP，必须为 `script-src` 与 `worker-src`
同时放行 `blob:`，否则插件加载会被拦下。
