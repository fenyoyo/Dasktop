# 插件包框架

Dasktop 的可插拔包框架：插件以**磁盘上的插件包**形式存在，由宿主在启动时扫描、读取源码、
构造受控上下文后激活。插件源码是标准 ESM 脚本，宿主不替它做任何代码转换。

与 `feat/plugin-system` 分支上的 uTools 式内置插件（Vue 组件编译进宿主、面向命令面板）
是两套并行的机制：本框架面向「用户自己放进去的第三方脚本」，关注的是**沙箱边界**，
因此入口是纯 JS 文件而不是 Vue 组件。

## 一、整体架构

```
┌──────────────────────────────────────────────────────────┐
│                    宿主程序（Tauri App）                  │
│                                                          │
│  ┌───────────────────┐        ┌────────────────────────┐  │
│  │      Rust 侧      │        │        前端侧           │  │
│  │                   │        │                        │  │
│  │ commands/plugin   │◄──────►│ entities/pluginPackage │  │
│  │  ├ list_plugins   │  IPC   │  ├ permissions 权限映射 │  │
│  │  ├ read_plugin_*  │        │  ├ context  受控上下文  │  │
│  │  └ 宿主能力命令    │        │  └ loader   扫描+激活   │  │
│  │                   │        │                        │  │
│  │ services/plugin   │        │ windows/settings/      │  │
│  │ infrastructure/   │        │  ├ useSettingsPlugins  │  │
│  │  filesystem/      │        │  └ PluginsPanel        │  │
│  │   plugin_package  │        │                        │  │
│  │   plugin_log      │        │                        │  │
│  └───────────────────┘        └────────────────────────┘  │
│                                        │                 │
│                                        ▼                 │
│                          ┌───────────────────────────┐   │
│                          │    受控 API 上下文 host    │   │
│                          │  （按 permissions 裁剪）   │   │
│                          └───────────────────────────┘   │
└────────────────────────────────┬─────────────────────────┘
                                 │ Blob URL + 动态 import
                    ┌────────────┴────────────┐
                    ▼                         ▼
            ┌───────────────┐         ┌───────────────┐
            │  插件包 A      │         │  插件包 B      │
            │  plugin.json  │         │  plugin.json  │
            │  index.js     │         │  index.js     │
            └───────────────┘         └───────────────┘
```

## 二、职责划分

### Rust 侧

| 模块 | 职责 |
|---|---|
| `commands/plugin.rs` | IPC 边界，只做参数接收与转发，不做权限判断 |
| `services/plugin/` | 解析插件根目录、编排扫描与包内文件访问、把通知落到 Tauri 事件 |
| `infrastructure/filesystem/plugin_package.rs` | 目录扫描、清单解析、**包内路径沙箱** |
| `infrastructure/filesystem/plugin_log.rs` | 按插件分文件的日志追加与容量控制 |
| `domain/plugin/` | 契约常量、清单与扫描结果类型、内嵌示例插件源码 |

补一条关键约定：**能力命令本身不做权限判断**。宿主能力扩展只需在后端加一个命令，
权限的裁剪与二次校验全部由前端受控上下文承担，两边不会各维护一套判断逻辑。

### 前端侧

| 模块 | 职责 |
|---|---|
| `entities/pluginPackage/types.ts` | 传输契约、协议接口、运行时视图三组类型 |
| `entities/pluginPackage/permissions.ts` | **权限映射表**：权限字符串 → 宿主能力描述；加载期预检与运行期二次校验 |
| `entities/pluginPackage/context.ts` | **受控 API 上下文**：按权限裁剪方法，调用前再校验一次 |
| `entities/pluginPackage/loader.ts` | **加载器**：扫描 → 读源码 → Blob 模块 → 激活；管理已加载表与通知订阅 |
| `entities/pluginPackage/api.ts` | 宿主命令的 `invoke` 封装（不导出给插件） |
| `shared/ipc/pluginPackage.ts` | 插件通知事件名与订阅 |
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
可在「设置 → 插件」中直接打开。

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
- **禁止直接 import 任何 Tauri API**，能力只能从 `host` 参数获取。
- 单一文件入口，不支持包内相对 `import`：源码以 Blob URL 交给原生 `import`，
  相对路径无法在 blob 协议下解析。需要读包内资源时用 `host.fs.read`。

最小示例（仓库内 `plugins/hello-dasktop/`，首次运行会被自动写入插件根目录）：

```js
export async function activate(host) {
  if (host.log) {
    await host.log.info("已激活");
  }

  // 权限是按方法裁剪的：只声明 fs:write 时读不到 host.fs.read
  if (host.fs?.write) {
    await host.fs.write("state.json", JSON.stringify({ at: Date.now() }));
  }

  await host.notify?.("Hello Dasktop", "插件已激活");
}

export async function deactivate(host) {
  await host.log?.info("已卸载");
}
```

## 四、加载流程

```
1. 设置页根组件挂载
   └─► initializePluginRuntime()（幂等，共享同一个 Promise）
       └─► list_plugins 扫描插件根目录
           （目录不存在则创建；目录下无子目录时写入内置示例包）

2. 对每个插件包（串行）
   ├─► 清单不可解析 / id 与目录名不一致 → 记为「加载失败」并继续下一个
   ├─► 权限预检：出现宿主不认识的权限 → 拒绝加载并记录缺失的权限
   ├─► read_plugin_entry 读取入口源码
   ├─► Blob 包装成模块 URL → 动态 import → 校验是否导出 activate
   ├─► 立即 revokeObjectURL（模块已实例化，不必等到卸载）
   └─► createPluginHost 构造受控上下文 → activate(host)

3. 快照更新
   └─► 记录写入 pluginRuntime，宿主面板展示状态与通知
```

关键点：**单个插件失败不影响其它插件，也不中断宿主启动**。所有失败都收敛成运行时记录里的
`error` 字段，设置页的 `onMounted` 对插件加载也不做 `await`。

## 五、权限表

| 权限 | 暴露位置 | 对应宿主命令 | 说明 |
|---|---|---|---|
| `fs:read` | `host.fs.read(relativePath)` | `read_plugin_package_file` | 读取插件包自身目录内的文本文件 |
| `fs:write` | `host.fs.write(relativePath, contents)` | `write_plugin_package_file` | 写入插件包自身目录内的文本文件 |
| `log:write` | `host.log.write/info/error` | `write_plugin_log` | 写入按插件隔离的日志 |
| `ui:notify` | `host.notify(title, message)` | `notify_from_plugin` | 向宿主发送通知 |

新增权限时同步修改三处：`PLUGIN_PERMISSIONS` 联合类型、`PLUGIN_PERMISSION_DEFINITIONS`
映射表、`createPluginHost` 里的分组裁剪。

## 六、安全边界

| 边界 | 防护点 | 实现位置 |
|---|---|---|
| 文件系统 | 插件包目录之外的文件访问被拦截 | `plugin_package::resolve_sandboxed_path` |
| 命令调用 | 插件拿不到原始 `invoke`，只能走上下文方法 | `context.ts` |
| 权限 | 清单未声明的能力，上下文不提供对应方法 | `context.ts` |
| 权限（二次） | 方法被调用时再校验一次授权集合 | `permissions::assertPluginPermission` |
| 加载期预检 | 清单出现未知权限直接拒绝加载 | `loader::activatePluginPackage` |
| 资源回收 | Blob URL 在 import 完成后立即回收 | `loader::importPluginModule` |
| 磁盘占用 | 单插件日志文件超过 512 KB 自动重置 | `plugin_log::reset_if_oversized` |
| 体积滥用 | 入口源码 2 MB、包内数据文件 4 MB 上限 | `domain/plugin/contract.rs` |

路径沙箱做两道独立校验，两道都需要，不能互相替代：

1. **形状校验**：拒绝绝对路径、盘符前缀、`..` 上跳、NTFS 数据流冒号（`file.txt:stream`）。
2. **落点校验**：对目标路径「已存在的最近祖先」做 `canonicalize` 后再比对是否仍在插件包内——
   形状校验识别不出符号链接与目录联接，一个指向 `C:\` 的 junction 就能让 `data/log.txt` 逃出沙箱。

回归用例见 `plugin_package.rs` 的 `tests` 模块（`cargo test --lib` 覆盖 6 条越权路径）。

## 七、能力扩展方式

宿主想给插件增加新能力，只需三步：

1. **Rust 侧**新增一个 `#[tauri::command]` 并在 `lib.rs` 的 `invoke_handler` 注册。
2. **上下文层**在 `context.ts` 新增一个方法（按新权限裁剪），内部调用该命令。
3. **权限映射表**在 `permissions.ts` 与 `types.ts` 各加一条记录。

插件作者只需在清单里声明对应权限，就能通过 `host` 调用新能力。
**无需修改加载器，无需重新设计协议。**

以「发 HTTP 请求（`net:request`）」为例：后端加一个 `plugin_http_request` 命令
（建议用 `reqwest`，注意当前 `Cargo.lock` 里没有 TLS 后端，需显式开启 `rustls-tls` feature），
上下文加 `host.http.get/post`，映射表加 `net:request` 一条即可。

## 八、当前框架的局限

- **同线程执行**：插件与宿主共享主线程，插件死循环会卡死 UI。彻底隔离需要迁移到
  Web Worker；本框架已经按「插件只能通过 host 访问能力」设计，迁移时不必改动插件侧协议。
- **全局对象可达**：同线程下插件理论上可通过 `window` 找到宿主的全局对象，
  这是权限门控唯一的理论缺口。Worker 方案可堵死这条路。
- **文件沙箱比文档更严格**：`fs:read` / `fs:write` 被限制在**插件包自身目录**内，
  而不是整个插件根目录——允许插件 A 改写插件 B 的源码会让「重新加载」变成提权入口。
- **无签名校验**：当前不验证插件来源，生产环境应加签名机制。
- **无版本兼容检查**：只校验「未知权限」这一种不兼容，不校验插件声明的宿主版本要求。
- **通知不落库**：`ui:notify` 的记录只在当前会话内存中保留最近 50 条，
  面板关闭重开后只剩日志文件里的历史。

以上局限都可以在框架不变的前提下逐项加固，属于后续演进方向。

## 九、开发与调试

```bash
# 路径沙箱回归测试（读写越权、id 白名单）
cargo test --lib --manifest-path src-tauri/Cargo.toml

# 前端类型检查与构建
pnpm build
```

调试插件时的几个落点：

- 插件列表不显示某目录 → 检查是否为 `.`/`_` 前缀（扫描时跳过），或清单 `id` 与目录名不一致。
- 插件显示「加载失败」→ 面板会直接给出原因：清单缺失、解析失败、未知权限、或 `activate` 抛错。
- 想查看插件输出 → 插件日志位于 `%APPDATA%\cn.syand.dasktop\plugin-logs\<plugin-id>.log`。
- 修改插件源码后需要在「设置 → 插件」点「重新加载」：已加载模块不会感知磁盘变化。

CSS 与 CSP 提示：`tauri.conf.json` 当前是 `"csp": null`，blob 脚本不受额外限制。
如果后续开启 CSP，必须为 `script-src` 放行 `blob:`，否则插件动态导入会被拦下。
