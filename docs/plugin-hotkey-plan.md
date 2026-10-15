# 插件全局热键设计说明

> 状态：已实现。本文档取代早期「插件在 `plugin.json` 里声明多条热键 + 覆盖表」的规划——那个方向已被推翻，改为**宿主端为每个已安装插件配置一个启动热键，并真正挂到系统**。

## 1. 方向

- 热键**不再由插件在 `plugin.json` 里声明**，改为在宿主设置页为每个已安装插件配置**一个启动热键**。
- 启动热键的语义是「打开 / 唤起这个插件」，意图不需要插件内再路由，因此没有 `hotkeyId` 与 `title`。
- 热键是**声明式宿主行为**：插件不需要调用任何命令即可被唤起，因此 **不绑定任何能力权限**（见 §4 桥脚本豁免）。
- 启动热键与 `window.kind` **正交**：热键决定「怎么叫醒」，kind 决定「醒来长什么样」，两者可任意组合——standard 窗口也能被热键唤起，quick 浮层也能从设置页点开。

## 2. 数据模型

### 2.1 清单（manifest）

`PluginManifest` 不含 `hotkeys` 字段，仅保留：

- `entry`、`id`、`name`、`permissions`、`version`
- `window?: { kind?: "standard" | "quick", width?, height? }`（窗口形态，与热键无关）

### 2.2 宿主配置表（plugin_hotkeys）

由宿主与设置页共同读写——两端都保留建表语句，因为注册层可能在设置窗尚未连库时就需要读配置（例如托盘常驻期间的热键注册）：

```sql
CREATE TABLE plugin_hotkeys (
  plugin_id TEXT NOT NULL PRIMARY KEY,
  accelerator TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
```

每插件一行，`plugin_id` 即主键，无 `hotkey_id` 列。

### 2.3 聚合结构 PluginHotkeyRegistration

由 `list_plugin_hotkeys` 命令返回，设置页一处渲染全部状态：

| 字段 | 含义 |
| --- | --- |
| `pluginId` | 所属插件 id（= 配置表主键） |
| `accelerator` | 生效快捷键，未配置时为空串 |
| `enabled` | 用户是否启用 |
| `status` | `ok` / `systemReserved` / `invalid` / `conflict` / `disabled` |
| `message` | 状态非 `ok` 时的说明，设置页红字展示 |

`status` 判定顺序（见 `hotkey.rs::classify`）：禁用 / 未配置优先于一切；其次快捷键合法性（系统保留含 Win 键、缺修饰键或主键）；最后横向冲突（把所有插件的生效键摊开统计，重复者后者不注册）。

## 3. Rust 侧职责

- `services/plugin/hotkey.rs`
  - `list_plugin_hotkeys`：聚合「已安装插件 + 宿主配置」算出每插件状态与冲突。
  - `set_plugin_hotkey(plugin_id, accelerator, enabled)`：落库并立即全量重挂。
  - `register_all_plugin_hotkeys`：先 `unregister_all` 再全量注册（幂等，每次改键 / 重载都重挂）。
  - `on_hotkey_triggered`：窗口已在则 eval 触发 `dasktop.hotkey` 回调 + 聚焦；不在则带 trigger 意图建窗。
- `services/plugin/mod.rs`：`open_plugin_window(plugin_id, trigger)`，首次建窗注入 `window.__DASKTOP_HOTKEY_INTENT__ = true`；quick 窗口加无边框 / 置顶 / 不进任务栏 / 失焦即隐。
- `services/plugin/bridge.rs`：注入 `dasktop.hotkey.onTrigger`（独立命名空间，不绑权限）。
- `lib.rs`：注册 `tauri-plugin-global-shortcut`，启动即 spawn 注册全部有效热键。

## 4. 前端设置页

`src/windows/settings/panels/PluginsPanel.vue` 的「快捷键」小节按插件列出，每行：

- 展示插件名（来自 `runtime.records`）；
- 输入框编辑 `accelerator`，保存即调用 `set_plugin_hotkey`；
- 开关 `enabled`；
- 冲突 / 非法状态红字提示。

类型与存储见 `src/entities/pluginPackage/*` 与 `src/shared/storage/database.ts`（`ensurePluginHotkeyStorage` 建表须与 §2.2 一致）。

## 5. 校验脚本

- `scripts/verify-plugins.mjs`：**不再**校验清单里的 `hotkeys`（字段已删除）；`dasktop.hotkey.*` 调用豁免权限检查（声明式行为不绑权限）。quick 窗口尺寸下限用 `PLUGIN_QUICK_WINDOW_MIN_SIZE`。
- `scripts/verify-acl.mjs`：命令名 `list_plugin_hotkeys` / `set_plugin_hotkey` 不变，ACL 不受影响。

## 6. 验收示例：translator

`plugins/translator` 是一个 quick 浮层 + 空权限的演示插件：订阅 `dasktop.hotkey.onTrigger`，在每次被启动热键唤起时聚焦输入框。在设置页为其配置一个启动热键（如 `Alt+T`），按下即唤起浮层并触发回调，从而验收「宿主配置 → 系统注册 → 唤起插件 → 插件收到意图」的完整链路。

## 7. 依赖升级说明

- 为使用 `tauri-plugin-global-shortcut 2.4.1`（真正把热键挂到系统），该插件要求运行时 `tauri ^2.12`，因此主版本升级到 `2.12`。
- 随之把 `windows` / `windows-core` 升级到 `0.62`，解决与 Tauri 2.12 内部 `windows 0.62.2` 的 `HWND` 类型分叉（否则编译报 `expected HWND, found windows::Win32::Foundation::HWND`）。
- 前端 `@tauri-apps/api`、`@tauri-apps/cli` 已对齐 `2.12.x`。
