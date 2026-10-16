# Dasktop 项目导览（Agent Guide）

> 本文档面向在本仓库工作的 AI 编码助手，帮助快速建立「代码在哪、分层怎么走、哪些地方不能乱改」
> 的心智模型。内容按当前代码实况维护，发现漂移应直接修正本文。
>
> 编码硬性规范（UTF-8、注释风格、不做兼容迁移）见根目录 [AGENTS.md](../AGENTS.md)，
> 环境搭建与踩坑记录见 [development.md](development.md)，本文不重复，只做架构导览。

---

## 1. 这是什么项目

Dasktop 是一款 **Windows 桌面整理工具**（对标 Fences）：在桌面上创建可拖动、可缩放、可吸附的
**Box**，把桌面文件、文件夹、快捷方式和此电脑/回收站等系统图标分组收纳。文件仍在磁盘原位、
仍由 Windows 默认程序打开，Dasktop 只提供「整理层」。

关键事实：

| 项 | 值 |
|---|---|
| 版本 / 标识 | `0.2.6` / identifier `cn.syand.dasktop` |
| 平台 | **仅 Windows 10 1809+ / 11**（大量 Win32 API、Shell COM，无跨平台计划） |
| 形态 | Tauri 2 桌面应用：Rust 后端 + WebView2 内 Vue 3 前端 |
| 包管理 | pnpm 11.5.3（corepack 锁定）、Node >= 20.19、Rust MSVC stable |
| 当前阶段 | **未上线**，无需保留任何旧逻辑/旧字段/旧数据结构的兼容分支（见 AGENTS.md） |

---

## 2. 技术栈

**前端**（`src/`）：Vue 3.5（`<script setup>`）+ TypeScript 6 + Pinia 3 + Vite 8 +
Tailwind CSS 4（`@tailwindcss/vite` 插件）+ motion（动画）+ @lucide/vue（图标）。
路径别名 `@/` → `src/`（[vite.config.ts](../vite.config.ts) 与 tsconfig 共同配置）。

**后端**（`src-tauri/`）：Tauri 2.12（`~2.12` 锁 minor，前后端必须同 minor）、
`windows` crate 0.62（按 feature 精挑 Win32 模块）、sqlx 0.8 + SQLite（经 tauri-plugin-sql
前端直连，Rust 侧热键等场景也用 sqlx）、tauri-plugin-autostart、tauri-plugin-global-shortcut、
reqwest 0.13（**必须 `default-features = false` + `native-tls`**，否则拉入 aws-lc-sys
需要 cmake/nasm，原因见 Cargo.toml 注释与插件框架文档第九节）。

---

## 3. 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm tauri dev` | 开发：起 Vite(1420) + 编译运行 Rust；前端 HMR、Rust 自动重编译 |
| `pnpm dev` | 只起前端，浏览器调 UI（无任何 Rust 能力） |
| `pnpm build` | `vue-tsc --noEmit` 类型检查 + 构建到 `dist/` |
| `pnpm tauri build` | 完整生产构建（产物：release exe、MSI、NSIS 安装包） |
| `cargo test --lib --manifest-path src-tauri/Cargo.toml` | Rust 单测（路径沙箱、身份收敛、Z 序等纯逻辑回归） |
| `pnpm verify:acl` | **校验 Tauri 命令 ACL 完整性**（见 §9），提交前应跑 |
| `pnpm verify:plugins` | 校验内置插件包契约（清单、引用、权限声明），提交前应跑 |
| `.\scripts\setup-dev.ps1` | 只读检查开发环境；`-Install` 自动补装 |

注意：dev 产物 exe 依赖 Vite 服务器，双击报 `ERR_CONNECTION_REFUSED` 是正常的；
要独立运行的 exe 必须 release 构建。详见 development.md。

---

## 4. 运行时架构：一个进程，五类窗口

Dasktop 只有一个进程（**单实例**，二次启动经命名管道把命令行意图转发给主实例，
见 `infrastructure/windows/single_instance.rs`），但包含多个**互相独立的 Tauri 窗口**，
每个窗口都是独立 WebView、各自挂载同一个 Vue app，由 URL 查询参数分发到不同视图：

- 分发逻辑只有一处：[src/app/App.vue](../src/app/App.vue)
- 入口：[src/app/main.ts](../src/app/main.ts)（挂 Pinia；生产环境拦截网页式右键菜单）

| 窗口 label | 视图（URL） | 数量 | 职责 |
|---|---|---|---|
| `main` | 无参数 → 设置页 | 1 | 设置窗口；启动时 `visible:false`，由 Rust 按启动意图决定是否显示 |
| `box_<id>` | `?boxId=<id>` | 每 Box 一个 | 透明无边框桌面小组件，固定在「桌面层」（§8） |
| `box_menu` | `?boxMenu=1` | 1（单例预载） | Box 的「更多」菜单，独立置顶透明窗，点击时才定位/显示 |
| `drag_preview` | `?dragPreview=1` | 1 | 原生拖文件时跟随鼠标的拖拽预览 |
| `plugin_<id>` | `http://plugin.localhost/<id>/<entry>` | 每插件一个 | **不加载宿主页面**，加载插件包自己的网页 + 注入 `window.dasktop` 桥 |

label 规则：`box_` 前缀在 [entities/desktopBox/windows.ts](../src/entities/desktopBox/windows.ts)
的 `boxWindowLabel`（注意 id 中的 `-` 会替换成 `_`，因为 Tauri label 限制）；
两类动态窗口靠 capability 中的 `box_*` / `plugin_*` 通配授权。

**启动分流**（`services/app/lifecycle.rs` + `lib.rs` setup）：

- `--autostart`（开机自启，注册项由 autostart 插件写入并带此参数）：静默驻留托盘，不显示窗口；
- `--workspace <id>`（工作区桌面快捷方式）：显示设置窗，前端根组件编排工作区还原；
- 其它（用户双击）：显示设置窗。

> 约定：任何「应用启动就要执行」的前端逻辑必须放在设置页**根组件**，不能放进
> `v-else-if` 条件渲染的面板里（未激活面板不挂载，onMounted 永不执行）。

退出应用时（`RunEvent::ExitRequested`）Rust 会恢复接管前的系统桌面图标显隐状态
（`services/app/lifecycle::restore_shell_desktop_icons_before_exit`）。

### 跨窗口通信

- **请求/响应**：前端 `invoke('<command>', …)` → Rust `#[tauri::command]`。
  所有命令集中注册在 [src-tauri/src/lib.rs](../src-tauri/src/lib.rs) 的 `invoke_handler`，
  新增命令必须在此注册 **并** 加进 ACL（§9），否则运行时被拒且构建期无报错。
- **事件**（常量集中在 `src/shared/ipc/`，禁止裸写事件名字符串）：
  - `dasktop-desktop-state-changed` / `dasktop-box-window-ready`（desktop.ts，
    含启动快照：批量开窗时主窗口把快照放跨 WebView storage，Box 窗只带 token）
  - `dasktop-box-context-menu-{open,ready,close,state,prepared}`（boxContextMenu.ts）
  - `dasktop://tray-create-box`、`dasktop://autostart-changed`（appTray.ts）
  - `dasktop://startup-workspace-requested`（workspace.ts）
  - `dasktop://plugin-notification`（pluginPackage.ts）

---

## 5. 后端分层（Rust，src-tauri/src/）

严格四层，依赖方向只允许从上到下：

```
commands/        IPC 边界：收参数、取窗口句柄、调 service；不写业务规则
   ↓
services/        用例编排：事务级业务流程、权限判定（require_permission）、调用多个基础设施
   ↓
infrastructure/  系统能力：Win32/Shell COM、Tauri 插件、数据库、HTTP、文件系统
domain/          纯数据契约：跨层共享的 struct/enum/常量，可序列化、不依赖系统 API
```

- 改 IPC 入参/返回先想 `domain/` 里的契约类型；`commands` 薄到不该出现业务分支。
- 模块顶部 `//!` 文档注释通常写明了本层定位，改动前先读。

### commands/（按命令前缀分文件）

`app.rs`（自启/启动意图/鼠标键状态）、`box_folder.rs`（Box 真实文件夹的建/删/迁移/拖入）、
`box_window.rs`（把 Box 窗固定到桌面层）、`desktop.rs`（桌面快照、文件增删改查、剪贴板、
系统图标显隐、原生右键菜单）、`native_drop.rs`（OLE 拖放目标注册/注销）、
`plugin.rs`（插件扫描/开窗 + 五条能力命令，**均为 `async fn` 且带 `window: Window`**，
原因见插件文档「为什么建窗命令必须 async」）、`workspace.rs`（窗口布局捕获/还原/快捷方式）。

### services/

| 模块 | 职责 |
|---|---|
| `app/lifecycle.rs` | 启动参数判定、自启项刷新、退出恢复；常量 `AUTOSTART_LAUNCH_ARGUMENT` |
| `app/box_window_glue.rs` | label 校验、工作线程查 hwnd、桌面状态监视线程编排 |
| `app/shell_icon_restore.rs` | 退出时批量恢复系统图标 |
| `box_folder/folder_service.rs` | 收纳根目录下 Box 文件夹的创建/删除/迁移/重命名 |
| `box_folder/drop_service.rs` | 拖入路径按策略（移动/复制/映射 + 同名策略）落盘 |
| `desktop/scan_service/` | 桌面快照扫描：`cache.rs` 缓存、`revision.rs` 版本号、`item_factory.rs` 组装展示项 |
| `desktop/query_service.rs` / `file_action_service.rs` / `shell_icon_service.rs` | 列表查询 / 文件操作 / 系统图标提取 |
| `plugin/mod.rs` | 插件扫描编排、建窗、调用方身份收敛、清单权限判定 |
| `plugin/bridge.rs` + `bridge.js` | 生成注入插件页的能力桥脚本（`include_str!` 内嵌 JS） |
| `plugin/protocol.rs` | `plugin` 自定义协议：URL→包内文件、MIME、400/403/404 |
| `plugin/hotkey.rs` / `window_preference.rs` | 全局启动热键注册 / 插件窗尺寸三级优先级收敛 |
| `workspace/` | 捕获当前窗口布局、按快照启动应用并还原窗口 |

### infrastructure/

- `windows/desktop_glue.rs` —— **Box「桌面层」Z 序核心**（§8），全仓库最精巧的 Win32 代码。
- `windows/native_drop/` —— 手写 OLE 拖放（`IDropTarget`/`IDataObject`、COM 封送、
  `HDROP`、IPC channel 回传），让透明无边框 Box 窗能接收资源管理器拖入。
- `windows/shell_context/` —— 系统原生右键菜单（PIDL 解析 + `IContextMenu`）。
- `windows/shell_desktop_icon/` —— 系统桌面图标显隐（注册表 + 通知 Explorer 刷新）。
- `windows/shell_virtual_item/` —— 此电脑/回收站/网络/用户文件夹等虚拟项的身份、目录取缓存。
- `windows/shell_file/` —— `ShellExecuteExW`（带 `SEE_MASK_NO_CONSOLE`，避免子进程日志
  混入开发终端）、回收站/文件操作、`.lnk` 快捷方式解析。
- `windows/shell_icon/` —— HICON → bitmap/png 提取、AppUserModelID。
- `windows/workspace/` —— 枚举/定位窗口、窗口截图、启动进程。
- `windows/common/` —— COM 初始化/封装、宽字符、全局内存、桌面路径等公共底座。
- `windows/{single_instance,mouse,folder_dialog,shell_clipboard,text_clipboard,webview_runtime}.rs`
  —— 单实例管道、鼠标状态、文件夹选择对话框、剪贴板、WebView2 启动参数
  （关闭遮挡检测以修 Box 黑闪，**必须在任何 WebView 创建前调用**）。
- `tauri/tray/` —— 托盘菜单、自启开关、设置窗显隐与「关闭即隐藏」的窗口事件处理。
- `filesystem/box_folder.rs` + `naming.rs` —— Box 文件夹命名/定位；
  `filesystem/transfer/` —— 文件移动/复制的 **plan（计划）→ executor（执行）→
  backup（备份）→ rollback（回滚）** 管线，改文件操作策略从这里入手。
- `filesystem/plugin_package.rs` / `plugin_log.rs` —— 插件包扫描、**包内路径沙箱**
  （形状校验 + canonicalize 落点校验，两道都不能少）、日志容量控制。
- `http/` —— 插件 `net:request`：仅 http/https、20s 超时、2MB 响应上限。
- `database/` —— Rust 侧 SQLite（sqlx）访问。

### domain/

`app/`（设置契约）、`desktop/`（桌面项、剪贴板、策略枚举）、`filesystem/`（传输契约）、
`plugin/`（清单/扫描记录/HTTP 类型/权限常量/窗口尺寸/示例包声明、协议 scheme 常量）。
这里只放纯数据，改动要想到它是前后端序列化契约。

---

## 6. 前端分层（src/）

按功能切片（FSD 风格），跨层 import 方向只允许 `windows → entities → shared`：

```
app/            应用外壳：main.ts、App.vue（URL 分发）、全局样式
entities/       领域层：每个领域自带 types/api/store/默认值，可被任意窗口复用
shared/         与领域无关的基础设施：IPC 封装、数据库、配置、通用 UI 组件
windows/        具体窗口的页面与交互：desktop / settings / boxContextMenu / dragPreview
```

### entities/（五个领域，入口通常是 index.ts）

| 领域 | 内容 |
|---|---|
| `appSettings/` | 设置项的类型（types）、默认值与取值范围/枚举（defaults）、设置页分组元数据（groups）、API |
| `desktopBox/` | Box 领域核心：Pinia store（`store.ts`，桌面状态共享）、布局常量（layout）、窗口生命周期（windows）、文件夹 API、删除确认策略 |
| `desktopItem/` | 桌面/Box 内项目的类型与 API、显示名规则、系统图标显隐同步（shellDesktopIconVisibilitySync） |
| `pluginPackage/` | 插件加载器（loader：扫描→运行时记录，幂等共享 Promise）、权限映射表（permissions）、窗口 label/关闭、API |
| `workspace/` | 工作区 store 与 API |

### windows/

- `desktop/` —— Box 窗。`index.vue` 只做组装，复杂交互全部拆进 `composables/`
  （窗口框架、文件项加载/选择/拖放/动作、标题编辑、折叠预览、右键菜单、生命周期）；
  `components/` 是纯展示组件（BoxHeader、BoxFileGrid、DesktopIcon、ResizeHandles）；
  `model/` 放拖放/选择的纯数据模型，`utils/` 放网格换算，`config/` 放图标视图常量。
  **新增交互优先建 composable，不要把逻辑堆回 index.vue。**
- `settings/` —— 设置窗。`panels/` 七个面板（外观/Box/文件/窗口/工作区/插件/关于）
  + `components/` 通用设置控件（SettingRow/Switch/Slider/Section…）
  + `composables/` 按面板域拆分动作（useSettings*）+ `model/navigation.ts` 侧边导航。
- `boxContextMenu/` —— 单例菜单窗：组件、动作 composable、菜单选项 model。
- `dragPreview/` —— 拖拽预览窗。

### shared/

`ipc/`（事件常量 + listen/emit/请求封装）、`storage/database.ts`（**前端直连 SQLite 的
唯一位置**，所有建表/读写 SQL 集中于此）、`config/appMeta.ts`（版本号等从 package.json 派生）、
`ui/`（跨窗口通用组件）。

---

## 7. 数据存储

- SQLite 数据库 `dasktop.db`（Tauri app data 目录：`%APPDATA%\cn.syand.dasktop\`），
  前端经 tauri-plugin-sql 直连，Rust 侧在需要时（热键、窗尺寸写回）直接用 sqlx 访问同一文件。
- 表名常量集中在 [appSettings/defaults.ts](../src/entities/appSettings/defaults.ts)
  的 `APP_SETTINGS_STORAGE`，建表集中在 [shared/storage/database.ts](../src/shared/storage/database.ts)。
- **前后端共同读写的表（`plugin_window_sizes`、`plugin_hotkeys`）两端各自保留建表语句，
  表结构必须逐字一致**，注释里已互相标注。

| 表 | 内容 |
|---|---|
| `boxes` | Box 布局（x/y/w/h、折叠、锁定、标题位置/透明度）+ 关联的**真实文件夹路径** `folder_path` |
| `app_settings` | 键值设置（value 为 JSON），键见 `APP_SETTING_KEYS` |
| `box_item_orders` | Box 内真实文件的手动排序（box_id + item_path） |
| `box_virtual_items` | Box 内**系统虚拟图标引用**（box_id + shell_id），只存引用，永不触发真实删除 |
| `shell_icon_visibility_records` | 应用接管隐藏过的系统图标及其接管前状态，退出/解除时恢复 |
| `plugin_window_sizes` | 每插件记住的窗口尺寸（Rust 关窗时写回） |
| `plugin_hotkeys` | 每插件一个启动热键 |
| `workspaces` | 工作区：窗口列表与附加命令均以 JSON 列整体存储 |

读写两侧的脏数据一律**就地过滤/夹取为默认值**（见 database.ts 的各类 sanitize 函数），
不抛错、不做迁移；表结构不兼容时直接 DROP 重建（项目未上线，这是明确政策，见 AGENTS.md）。

运行期用户数据目录还有：`plugins/`（插件包根目录，空目录时播种内置示例包）、
`plugin-logs/<plugin-id>.log`。

---

## 8. 核心机制：Box 的「桌面层」Z 序

这是全项目最反直觉的设计，动相关代码前**必须**先读
[box-window-desktop-layer.md](box-window-desktop-layer.md)。要点：

- 需求互斥：既要 Win+D/Win+M 时保持可见，又永远不能遮挡普通应用窗口。
  方案是随桌面状态切换两层 Z 序：普通态置底（`HWND_BOTTOM`，所有窗口之下、桌面图标之上）；
  显示桌面态进入置顶带并落到**置顶带最底部**（高于被提升的桌面宿主、低于任务栏）。
- 状态判据是 Z 序几何遍历（第一个可见非置顶顶层窗口是不是桌面宿主），**不是焦点判断**，
  150ms 轮询线程只投递任务到主线程执行。
- 窗口过程子类化拦截：`WM_WINDOWPOSCHANGING` 强制 `SWP_NOZORDER`（点击 Box 不会把它抬起来）、
  吞掉 `SC_MINIMIZE`（免疫 Win+M）。
- 代码：`infrastructure/windows/desktop_glue.rs`（核心）、
  `services/app/box_window_glue.rs`、`commands/box_window.rs`、
  前端 `entities/desktopBox/windows.ts`（开窗后幂等调用，失败仅降级为普通顶层窗）。
- 被否决的 WorkerW 吸附 / 永久置顶方案及原因记录在该文档第 5 节，不要重走。
- 诊断：`$env:DASKTOP_BOX_DIAG = "1"` 后日志在 `%TEMP%\dasktop-box-diag.log`。

---

## 9. 核心机制：插件包框架与双层 ACL

完整设计见 [plugin-package-framework.md](plugin-package-framework.md)
和 [plugin-development-guide.md](plugin-development-guide.md)。速记：

- 插件 = `%APPDATA%\cn.syand.dasktop\plugins\<id>\` 下的 `plugin.json` + 网页文件；
  宿主不执行插件代码，只通过 `plugin` 协议（Windows 上 `http://plugin.localhost`）加载页面，
  建窗时注入 `bridge.js`（`window.dasktop`，五个能力：fs:read / fs:write / log:write /
  net:request / ui:notify）。
- 清单可选 `icon` 字段（包内图片，png/jpg/jpeg/gif/webp/svg）：扫描期校验路径/格式/体积后
  下发 `iconUrl` 给设置页插件列表展示；声明即必合法，非法整包不可用；未声明用拼图占位。
- **两层安全判定缺一不可**：
  1. 窗口级 ACL：`permissions/*.toml` 定义权限 + `capabilities/default.json` 授宿主窗口
     （main/box_*/box_menu/drag_preview）、`capabilities/plugin.json` 只授 `plugin_*`
     五条能力命令——**两份 capability 的命令集合刻意不相交**；
  2. 插件级判定：每条能力用例第一行 `require_permission` 现读磁盘上的清单（不缓存）。
- `window.dasktop` 桥**不是安全边界**（插件可直接调 `__TAURI_INTERNALS__.invoke`，
  照样被第一层 ACL 拦）；调用方身份取自窗口 label `plugin_<id>`，不信前端传参。
- `src-tauri/permissions/` 目录一旦缺失，应用命令鉴权会**静默整条失效**——
  这就是 `pnpm verify:acl` 的存在意义。

---

## 10. 常见改动落点清单

**新增一个前端可调用的 IPC 命令**（四处缺一，漏 ACL 只在运行时暴露）：

1. Rust：`commands/<域>.rs` 写命令 → `services/` 编排 → `lib.rs` 的 `invoke_handler` 注册；
2. ACL：宿主命令加进 `src-tauri/permissions/host-commands.toml`；
   插件能力命令才进 `plugin-capabilities.toml`（放错等于向插件开窗）；
3. 前端：在对应 `entities/*/api.ts`（或 `shared/ipc/`）封装 invoke，不裸调；
4. 跑 `pnpm verify:acl` + `pnpm build`。

**新增一个设置项**：

1. `entities/appSettings/types.ts` 加类型 → `defaults.ts` 加键、默认值、数值范围
   （数值键加进 `APP_SETTING_NUMBER_LIMITS`，database.ts 的 sanitize 即自动覆盖）；
2. 枚举类设置在 `groups.ts` 加选项文案；在对应 `settings/panels/*.vue` 加控件；
3. Rust 侧需要消费时走 `domain/app/` 契约；设置读写已由 database.ts 通用化，通常无需动 SQL。

**改 Box 文件拖入/移动/复制行为**：前端 `windows/desktop/composables/useBoxFile*` +
Rust `services/box_folder/drop_service.rs` + `infrastructure/filesystem/transfer/`，
策略枚举在 `entities/appSettings`（移动/复制/映射、同名 rename/skip/replace、删除三策略）。

**改桌面快照/图标/系统项**：Rust `services/desktop/scan_service/`（缓存 + revision）、
`infrastructure/windows/shell_virtual_item/`、`shell_icon/`；前端 `entities/desktopItem/`。

**给插件加新能力**：见插件框架文档第九节（Rust 命令 + 两层 ACL + service 首行
require_permission + bridge.js CAPABILITY_TABLE + permissions.ts + types.ts +
contract.rs，共多处同步，两个 verify 脚本会抓漂移）。

**新增托盘菜单项**：`infrastructure/tauri/tray/menu.rs`（菜单）+ 事件常量到
`shared/ipc/appTray.ts` + 设置页根组件订阅。

**改启动/自启/单实例行为**：`services/app/lifecycle.rs`、
`infrastructure/windows/single_instance.rs`、`infrastructure/tauri/tray/autostart.rs`、
`lib.rs` setup。前端启动即执行的逻辑只能挂根组件。

---

## 11. 易错点与硬性提醒

- **未上线项目：删旧逻辑，不留兼容分支、不写迁移脚本、不留废弃配置**（AGENTS.md）。
  唯一允许的「重建」是 database.ts 检测到旧表结构直接 DROP 重建。
- 所有文件 UTF-8；新增/修改代码必须按阿里巴巴风格补注释，说明业务意图与边界；
  TS/Vue 公共类型、store、跨模块函数写 JSDoc；Rust pub 项写 rustdoc。
- Tauri/npm 两侧版本必须同 minor（`~2.12`）；不要随意升级，development.md 开头有说明。
- `package.json` 的 `"tauri": "tauri"` 必须保持透传。
- 前端 `verify` 脚本覆盖不到的插件目录（`plugins/`）与 Rust ACL，是构建期盲区，
  改动相关文件后必须跑 `pnpm verify:plugins` / `pnpm verify:acl`。
- Win32 常量/句柄类逻辑 `cargo check` 查不出语义错误，必须**实机验证**（development.md FAQ）。
- 链接失败 `LNK1104 Dasktop.exe` = 上一次构建的程序还在运行，用 `tasklist | Select-String Dasktop` 排查。
- Box 开窗走前端 `new WebviewWindow`（最终走 Tauri async 建窗命令，安全）；
  但 **Rust 侧自己建窗的命令必须是 `async fn`**，同步会在主线程死锁（插件窗口空白 + 宿主卡死）。
- 自定义协议包内引用只能写相对路径（`./x.html`），`/x.html` 会被解析到协议根 → 404。
- 数据库布尔存 0/1；前端读 Store 的多窗口状态靠事件 + 启动快照，不要假设只有一个 WebView。

---

## 12. 文档索引（docs/）

| 文档 | 内容 |
|---|---|
| [development.md](development.md) | 环境要求、一键检查脚本、手动搭建、构建/代理/踩坑 FAQ（给人看的开发指南） |
| [box-window-desktop-layer.md](box-window-desktop-layer.md) | Box 桌面层 Z 序的完整推导、实测与被否决方案 |
| [plugin-package-framework.md](plugin-package-framework.md) | 插件包框架：隔离模型、ACL、桥、协议、安全边界、扩展落点、调试手册 |
| [plugin-development-guide.md](plugin-development-guide.md) | 插件作者向开发指南 |
| [plugin-hotkey-plan.md](plugin-hotkey-plan.md) | 插件启动热键设计 |
| [desktop-extension-tech-plan.md](desktop-extension-tech-plan.md) | 桌面接管相关技术方案 |
| [backend-structure-refactor-plan.md](backend-structure-refactor-plan.md) | Rust 三层/四层重构依据 |
| `frontend-*-structure-refactor-plan.md`（docs/ 与 superpowers/specs/） | 前端目录分层、设置页、Box 窗口结构的重构设计 |
| `superpowers/plans/`、`superpowers/specs/` | 按日期归档的特性计划（plan）与设计稿（spec），写新功能前先搜这里有没有历史方案 |

历史方案文档价值很高：被否决方案（如 WorkerW 吸附）通常记录了失败原因，改架构前先检索。
