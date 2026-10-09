# 开发指南

面向需要在本机（或另一台电脑）跑起 Dasktop 源码的开发者。包含环境要求、
一键检查脚本、手动搭建步骤，以及开发过程中实际踩过的坑。

如果只想知道「怎么最快跑起来」，直接看下面的[快速开始](#快速开始)。

---

## 环境要求

| 组件 | 版本要求 | 说明 |
|---|---|---|
| 操作系统 | Windows 10 1809+ / Windows 11 | 项目大量使用 Win32 API，仅支持 Windows |
| Node.js | **>= 20.19.0** | 与 `package.json` 的 `engines.node` 一致；低于此版本 Vite 8 无法启动 |
| pnpm | **11.5.3** | 由 `package.json` 的 `packageManager` 字段锁定，经 corepack 自动切换 |
| Rust | **stable，target 为 `x86_64-pc-windows-msvc`** | 必须是 MSVC 工具链，GNU 工具链无法链接 WebView2 |
| MSVC 生成工具 | Visual Studio 2022 Build Tools，含「使用 C++ 的桌面开发」工作负载 | 提供链接器与 Windows SDK |
| WebView2 Runtime | 任意较新版本 | Windows 11 通常已内置；Windows 10 可能需要单独安装 |

> **版本对齐原则**：`src-tauri/Cargo.toml` 中的 Rust 侧 Tauri 依赖与
> `package.json` 中的 npm 侧 `@tauri-apps/*` 包必须保持**同一 major/minor**
> （例如 `tauri 2.11.x` 对 `@tauri-apps/api 2.11.x`）。`Cargo.toml` 已用 `~`
> 锁住 patch 位，不要随意升到 `2.12`，否则两侧协议可能不兼容。

---

## 快速开始

在仓库根目录打开 **PowerShell**，执行环境检查脚本：

```powershell
# 只检查，不改动任何文件（推荐先跑这个）
.\scripts\setup-dev.ps1

# 检查并自动补装缺失依赖（需要 winget）
.\scripts\setup-dev.ps1 -Install
```

脚本会逐项检查 Node / pnpm / Rust / MSVC / WebView2 / 打包工具链，给出中文报告
和修复命令。检查通过后：

```powershell
pnpm install
pnpm tauri dev
```

`pnpm tauri dev` 会自动先启动 Vite 开发服务器（`localhost:1420`），再编译并
运行 Rust 桌面程序。首次编译需要几分钟，之后改前端代码热更新、改 Rust 代码
自动重编译重启。

> 如果 PowerShell 提示「无法加载文件，因为在此系统上禁止运行脚本」，执行
> 一次 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` 即可。

### 脚本参数

| 参数 | 作用 |
|---|---|
| （无） | 只读检查并打印报告 |
| `-Install` | 用 winget 补装缺失的 Node / Rust / BuildTools / WebView2，并执行 `pnpm install` |
| `-SkipBundleTools` | 跳过 WiX / NSIS 打包工具链的检查与预置（只做前端 + Rust 调试时更快） |
| `-Proxy <url>` | 访问 GitHub 的本地代理，如 `http://127.0.0.1:7890`，用于下载打包工具链 |

脚本对缺失的运行时依赖会以退出码 `1` 结束，方便接入 CI 或批处理判断。

---

## 手动搭建步骤

不想用脚本，或脚本自动安装失败时，按下面顺序手动来。

### 1. Node.js 与 pnpm

```powershell
winget install OpenJS.NodeJS.LTS
```

安装后**重开终端**，再启用 corepack 获得正确版本的 pnpm：

```powershell
corepack enable
corepack prepare pnpm@11.5.3 --activate
```

corepack 会读取 `package.json` 的 `packageManager` 字段，保证所有人用同一个
pnpm 版本，避免 lockfile 格式漂移。

### 2. Rust 工具链

```powershell
winget install Rustlang.Rustup
```

安装后重开终端，确认默认工具链是 MSVC：

```powershell
rustup default stable-x86_64-pc-windows-msvc
rustc -vV
```

`rustc -vV` 的输出中必须有一行 `host: x86_64-pc-windows-msvc`。若显示
`windows-gnu`，用上面的 `rustup default` 命令切换。

> **Rust 默认不在 PATH**：rustup 安装后会写入 `%USERPROFILE%\.cargo\bin`，
> 但已打开的终端不会自动刷新。**重开终端**即可；CI 或脚本中可以显式
> `$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"`。

### 3. MSVC 生成工具

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

这一步体积较大（数 GB），耗时取决于网速。也可以从 Visual Studio 官网下载
Build Tools 安装器，手动勾选「使用 C++ 的桌面开发」。

### 4. WebView2 Runtime

Windows 11 一般已内置。若脚本报告缺失：

```powershell
winget install Microsoft.EdgeWebView2Runtime
```

### 5. 前端依赖

```powershell
pnpm install
```

---

## 项目结构与开发流程

```
Dasktop/
├── src/                     前端（Vue 3 + TypeScript + Pinia）
│   ├── entities/            领域层：Store + API 封装
│   ├── shared/              共享层：IPC 封装、存储、数据库
│   └── windows/             窗口层：设置页、Box 页等页面
├── src-tauri/               Rust 后端
│   ├── src/commands/        IPC 命令层（前端 invoke 的入口）
│   ├── src/services/        用例编排层
│   ├── src/infrastructure/  基础设施层（Win32 / Tauri 系统 API）
│   ├── tauri.conf.json      Tauri 配置（窗口、打包、标识）
│   └── Cargo.toml           Rust 依赖
├── scripts/setup-dev.ps1    开发环境检查脚本
└── docs/                    设计文档与开发指南
```

Rust 侧采用三层结构：`commands`（IPC 入口）→ `services`（用例编排）→
`infrastructure`（系统 API 封装）。新增功能时按这个分层放置代码。

### 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm tauri dev` | 开发调试（启动 Vite + 编译运行桌面程序） |
| `pnpm dev` | 只启动前端 Vite 服务（浏览器里调 UI，无 Rust 能力） |
| `pnpm build` | 类型检查 + 构建前端产物到 `dist/` |
| `pnpm tauri build` | 完整生产构建，产出 exe 与安装包 |
| `pnpm vue-tsc --noEmit` | 只做 TypeScript 类型检查 |

---

## 开发中踩过的坑

以下是本机开发时**实际遇到并解决**的问题，换电脑时大概率会再次碰到。

### 1. dev 版 exe 双击打不开，报 `ERR_CONNECTION_REFUSED`

**现象**：构建出的 exe 直接双击，弹出「localhost 拒绝连接」。

**原因**：`tauri.conf.json` 里 `devUrl: "http://localhost:1420"`。**dev 构建**
出的 exe 不内嵌前端资源，而是去连本地 Vite 服务器；Vite 没跑，自然连不上。

**结论**：`pnpm tauri dev` 生成的 exe 只能配合开发服务器使用。要一个能独立
双击运行的程序，必须走 `pnpm build && pnpm tauri build` 产出 **release** 版
——release 版才会把前端内嵌进 exe。

### 2. 工作区启动的应用日志混进开发终端

**现象**：通过工作区启动的外部程序，其输出刷在 Dasktop 的开发终端里。

**原因**：不是 stdout 继承，而是 `ShellExecuteW` 会给子进程**挂上（或复用）
一个控制台**。开发态 Dasktop 本身挂着终端控制台，子进程共享同一控制台，
于是日志混流。

**解法**：改用 `ShellExecuteExW` 并带 `SEE_MASK_NO_CONSOLE`（`0x8000`），
阻止子进程共享控制台。已实现在
`src-tauri/src/infrastructure/windows/workspace/window_capture.rs`。

### 3. `schemars 0.8.22` 编译失败（`indexmap` 缺 `std` feature）

**现象**：`cargo check` 报 E0107，指向 `indexmap` 的 `IndexMap<K, V>` 缺少
默认哈希参数。

**原因**：`indexmap 1.9.3` 的 `build.rs` 用 autocfg 探测 `has_std`，在新版 rustc
下探测失败，于是走了 no-std 分支。且 Cargo 的 **feature 合并只在同一依赖图
内生效**，`[build-dependencies]` 是独立解析的。

**解法**：在 `Cargo.toml` 的 `[dependencies]` 与 `[build-dependencies]`
**两处都**显式声明：

```toml
indexmap = { version = "1.9.3", features = ["std"] }
```

改完若仍报错，清理构建缓存后重试：

```powershell
Remove-Item -Recurse -Force src-tauri\target\debug\build\indexmap-*, src-tauri\target\debug\build\schemars-*
Remove-Item -Recurse -Force src-tauri\target\debug\.fingerprint\indexmap-*, src-tauri\target\debug\.fingerprint\schemars-*
```

### 4. 快捷方式启动 Dasktop 看起来「点了没反应」

**原因有两个，且同时存在**：

- 设置窗口在 `tauri.conf.json` 中配置为 `visible: false`，普通启动时须由
  `lib.rs` 主动调用 `show_settings_window` 才会显示；
- 工作区还原逻辑挂在前端**设置页根组件**的 `onMounted` 上。而设置页内的面板
  由 `v-else-if` **条件渲染**——未激活的页签其组件根本不挂载，`onMounted`
  永不执行。

**解法**：`lib.rs` 的 setup 中按启动参数分流（工作区快捷方式 / 开机自启 /
手动启动），前端把工作区还原编排放在设置页根组件而非面板内。

> **相关设计约定**：任何「应用启动就要执行」的前端逻辑，都不能放在面板
> 组件里，必须放在根组件。

### 5. 链接期 `LNK1104: 无法打开文件 Dasktop.exe`

**现象**：`pnpm tauri build` 在最后链接阶段失败。

**原因**：**上一次构建出的 Dasktop 程序仍在运行**，占用了 exe 文件。

**排查**：

```powershell
tasklist | Select-String -Pattern "Dasktop"
```

> 注意：`Get-Process -Name Dasktop` 若「无输出」，**不能**直接判定「没有进程」
> ——某些环境下 PowerShell 输出会被吞。用 `tasklist` 更可靠。

**解法**：关掉正在运行的 Dasktop，重跑构建。

### 6. 首次 `tauri build` 卡在下载 WiX / NSIS

**现象**：构建 MSI 阶段长时间无进展，或报下载超时。

**原因**：Tauri 首次构建会从 GitHub 下载 WiX 3.14 与 NSIS 工具链，国内网络
较慢。

**解法**：用脚本预置（走代理）：

```powershell
.\scripts\setup-dev.ps1 -Install -Proxy http://127.0.0.1:7890
```

工具链缓存位置：

- WiX：`%LOCALAPPDATA%\tauri\WixTools314\`（注意是 `314` 不是 `3141`，
  且解压后必须是**扁平结构**——`candle.exe` / `light.exe` 直接在该目录下）
- NSIS：`%LOCALAPPDATA%\tauri\NSIS\`（含 `makensis.exe`）

---

## 生产构建

```powershell
pnpm build          # 先做类型检查并构建前端到 dist/
pnpm tauri build    # 再编译 Rust 并打出安装包
```

产物：

- `src-tauri/target/release/Dasktop.exe` —— 可独立运行的主程序
- `src-tauri/target/release/bundle/msi/*.msi` —— MSI 安装包
- `src-tauri/target/release/bundle/nsis/*-setup.exe` —— NSIS 安装包

> `package.json` 中的 `"tauri": "tauri"` 必须保持**透传**。若写成
> `"tauri": "tauri dev"`，`pnpm tauri build` 会展开成 `tauri dev build` 报错。

### 网络与代理

访问 GitHub（下载工具链、推送代码）在国内常需代理，且**代理端口会变动**。
使用前先探测：

```powershell
foreach ($port in 7890, 10809, 15490, 33211, 60010) {
    $ok = curl.exe -s -o NUL -w "%{http_code}" --max-time 5 -x "http://127.0.0.1:$port" https://github.com
    if ($ok -in "200", "301", "302") { Write-Output "可用代理: 127.0.0.1:$port" }
}
```

直连失败常见报错是 `schannel: server closed abruptly`。

---

## 常见问题

**Q：`pnpm install` 后 IDE 报找不到模块？**
重启 IDE 或在 IDE 内重载 TypeScript 服务。Vite 别名 `@/` 指向 `src/`，
由 `vite.config.ts` 与 `tsconfig.json` 共同配置。

**Q：`pnpm tauri dev` 报端口 1420 被占用？**
`vite.config.ts` 设了 `strictPort: true`，端口被占会直接失败。找出占用进程：

```powershell
netstat -ano | Select-String ":1420"
```

**Q：Rust 代码改了但没生效？**
`pnpm tauri dev` 会监听 `src-tauri/` 自动重编译。若没反应，检查终端是否有
编译错误未通过。

**Q：`cargo check` 报「error deleting lock file... 拒绝访问」？**
通常是 `pnpm tauri dev` 进程仍占用 `target/` 目录，不是代码问题。停掉 dev
进程再试。

**Q：`cargo check` 通过但运行时行为不对？**
`cargo check` **查不出 newtype 常量的语义错误**（例如把 `PIPE_ACCESS_DUPLEX`
的值传错位置）。涉及 Win32 常量与句柄的逻辑必须**实机验证**。

**Q：另一个电脑上已经有旧的注册表自启项，会怎样？**
自启注册项由 `tauri-plugin-autostart` 写入，命令中带有 `--autostart` 标记。
程序启动时会自动重写一次（`refresh_autostart_entry`），无需手动关开自启开关。

---

## 相关文档

- [CHANGELOG.md](../CHANGELOG.md) —— 版本更新记录
- [AGENTS.md](../AGENTS.md) —— 代码注释与兼容性约定
- [docs/](.) —— 各模块的设计与重构方案
