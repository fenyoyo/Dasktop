# Box 窗口的「桌面层」Z 序设计

> 结论文档。历史求助版已由本文取代——难点已解决，方案参考 Rainmeter 的
> `AlwaysOnTop = -2`（On Desktop）实现。

---

## 1. 需求与约束

Box 是 Dasktop 的桌面小组件（Tauri 2 + WebView2，透明无边框顶层窗口），期望行为：

| # | 需求 | 状态 |
|---|---|---|
| 1 | 常驻桌面，悬浮在桌面图标之上，可交互（点击打开、拖放文件） | ✅ |
| 2 | Win+D「显示桌面」时保持可见 | ✅ |
| 3 | Win+M「全部最小化」时保持可见 | ✅ |
| 4 | 不遮挡主窗口（设置窗口） | ✅ |
| 5 | **不遮挡任何其它应用窗口** | ✅ |

**需求 2 与 5 本质互斥**：任何「永远在最上层」的实现都必然违反 5；任何「在最下层」
的实现都必然在 Win+D 时被提升到前台的桌面盖住。因此不能靠单次 `SetWindowPos` 解决，
必须引入「桌面状态」这一维度。

---

## 2. 结论：两层 Z 序模型

| 桌面状态 | Box 的 Z 序位置 | 效果 |
|---|---|---|
| 普通 | `HWND_BOTTOM` | 位于所有应用窗口之下、桌面图标之上 → 永不遮挡，且可直接点击 |
| 显示桌面 | 置顶带**最底部** | 高于被提升的桌面，低于任务栏等真正的置顶窗口 → 保持可见 |

---

## 3. 机理：关键在于桌面宿主的 Z 序会变化

按 Win+D 时，**Explorer 把桌面图标宿主窗口从 Z 序最底层提升到「非置顶带的顶端」**。
宿主的身份随系统版本而变：

- Windows 11 24H2 起：`Progman`（`GetShellWindow()`）直接持有 `SHELLDLL_DefView`；
- 更早版本：`SHELLDLL_DefView` 挂在某个全屏 `WorkerW` 下。

这一点决定了为什么「只把 Box 放在 `HWND_BOTTOM`」不够：宿主被提升后，Box 就落到了
宿主**之下**，被「吞掉」。所以显示桌面时必须把 Box 搬进置顶带。

### 3.1 实机 Z 序证据（Windows 11，2026-10-09 实测）

从 `GetTopWindow(NULL)` 沿 `GW_HWNDNEXT` 向下遍历顶层窗口（`T` = `WS_EX_TOPMOST`）：

```
普通状态                          按 Win+D 之后
---                               ---
 0..25  T  (置顶带)                0..25  T  (置顶带，未受影响)
 26     .  PseudoConsoleWindow     26     .  PseudoConsoleWindow
 27     .  IME                     27     .  IME
 ...                              28     .  Progman   ← 被提升到非置顶带顶端
 35     V  CabinetWClass(最小化)
 ...                              ...
 n     .  Progman  ← 在最底层      36     V  CabinetWClass(最小化后落到下方)
```

两个可直接利用的事实：

1. **置顶带在 Win+D 前后不变**，因此把 Box 插进置顶带即可免疫 Win+D；
2. 显示桌面时**非置顶带的第一个可见窗口就是桌面宿主**，这就是状态判据。

---

## 4. 实现

### 4.1 状态判据（`desktop_is_frontmost`）

> 从 Z 序顶端向下遍历，遇到的**第一个「可见且非置顶」的顶层窗口**就是桌面宿主。

- 普通状态：宿主被钉在最底层，遍历必然先撞上普通应用窗口 → `false`；
- 显示桌面：宿主上方只剩置顶窗口与不可见辅助窗口（`IME` / `MSCTFIME UI` 之类）→ `true`。

**为什么不用 `GetForegroundWindow() == 桌面宿主`**：该判据依赖焦点，用户点一下 Box
就会把焦点从桌面夺走，从而被误判为「已退出显示桌面」，Box 会立刻沉到桌面之下消失。
Z 序几何判据只看层级、不看焦点，因此点击 Box、点击桌面图标都不会误判。
Rainmeter 的 `System::CheckDesktopState` 用隐藏辅助窗口的相对位置做等价判断。

判据只做一次短路遍历（正常状态下撞到第一个可见非置顶窗口即返回，只走几十步），
150ms 轮询的开销可忽略。

### 4.2 层级落点（`apply_box_band`）

```rust
if !desktop_shown {
    SetWindowPos(box, Some(HWND_BOTTOM), ...)?;      // 所有窗口之下、桌面之上
    return;
}
// 显示桌面：必须进置顶带，且要分两步
SetWindowPos(box, Some(HWND_TOPMOST), ...)?;          // 1. 真正拿到 WS_EX_TOPMOST
let anchor = desktop_icons_host()
    .and_then(backmost_topmost_window)                // 最靠后的置顶窗口
    .filter(|a| *a != box)
    .unwrap_or(HWND_TOPMOST);                         // 找不到时降级为置顶带顶部
SetWindowPos(box, Some(anchor), ...)?;                // 2. 落到置顶带最底部
```

**第 1 步不能省（实测踩坑）**：MSDN 判定「窗口是否置顶」的依据是**被排到所有置顶窗口
之上**，而不是 `hWndInsertAfter` 是不是一个置顶窗口。所以只做第 2 步（插到最靠后的置顶
窗口之后）得到的窗口虽然**高于桌面**，却**不带 `WS_EX_TOPMOST`**：功能上勉强够用，但会
被 `refresh_box_desktop_band` 的「实际样式与目标不符」检查每 150ms 判定一次、反复重排；
更关键的是它一旦被任何非置顶窗口超越就会掉到桌面之下。Rainmeter 的
`System::PrepareHelperWindow` 同样是「先 `HWND_TOPMOST`，再精确插入」。

排层标志统一为 `SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER |
SWP_NOSENDCHANGING`。其中 **`SWP_NOSENDCHANGING` 是必需的**：它抑制
`WM_WINDOWPOSCHANGING`，让本模块自己的排层调用绕过后面的拦截逻辑，否则 Box 永远
无法离开底层、也无法进入置顶带。

### 4.3 实机实测结果（Windows 11，2026-10-09）

顶层窗口从 Z 序顶端向下编号（0 = 最前），`progman` = 桌面宿主，`tray` = 任务栏：

| 状态 | progman | tray | Box | Box 置顶 | Box 可见 |
|---|---|---|---|---|---|
| 普通 | 288 | 8 | **286 / 287** | 否 | 是 |
| 按 Win+D 后 | **28** | 7 | **24 / 25** | **是** | 是 |
| 再按 Win+D 后 | 288 | 7 | **286 / 287** | 否 | 是 |

即：普通状态下 Box 位于**全部 285 个窗口之后、桌面之前**（永不遮挡）；显示桌面时
Box 位于**桌面之前、任务栏之后**（保留可见且不压住任务栏）。

另外两项行为也已实测：

| 操作 | 结果 |
|---|---|
| 外部 `SetWindowPos(box, HWND_TOP, …, SWP_NOMOVE\|SWP_NOSIZE)` | Z 序序号不变 → `SWP_NOZORDER` 拦截生效，点击/激活无法把 Box 抬起来 |
| `PostMessage(box, WM_SYSCOMMAND, SC_MINIMIZE)` | `IsIconic=false`、`visible=true` → Win+M 免疫生效 |

### 4.4 窗口过程拦截（`box_wndproc`）

| 消息 | 处理 | 目的 |
|---|---|---|
| `WM_WINDOWPOSCHANGING` | 强制 `SWP_NOZORDER` | Box 不参与 Z 序竞争：点击 / 激活都不会把它抬到其它窗口之上——这就是 Rainmeter 文档里「On Desktop 不能被带到前台」的实现方式 |
| `WM_WINDOWPOSCHANGING` 且 `x == -32000` | 追加 `SWP_NOMOVE \| SWP_NOSIZE` | 兜底拦住 Win+D 的哨兵移动（样式上本已不该被命中） |
| `WM_SYSCOMMAND + SC_MINIMIZE` | 直接 `return 0` | Win+M「全部最小化」及一切最小化命令。Box 常驻桌面，不响应最小化 |

### 4.5 状态监视（`start_desktop_state_monitor`）

桌面状态翻转是全局事件、与具体 Box 无关，因此每进程只启动一条 150ms 轮询线程；
线程自身不做任何 Win32 窗口操作，只把 `refresh_box_desktop_band` 投递到主线程执行
（`SetWindowPos` 与子类化过程都必须在窗口归属线程上）。没有存活的 Box 时空转待命。

`refresh_box_desktop_band` 只在「状态翻转」或「Box 实际置顶与否与目标不符」时才
调用 `SetWindowPos`，避免无谓的 Z 序扰动引发 WebView2 重绘。

### 4.6 代码位置

| 文件 | 职责 |
|---|---|
| `src-tauri/src/infrastructure/windows/desktop_glue.rs` | 状态判据、层级落点、窗口过程拦截（核心） |
| `src-tauri/src/services/app/box_window_glue.rs` | label 校验、工作线程解析 hwnd、状态监视线程 |
| `src-tauri/src/commands/box_window.rs` | Tauri 命令入口 |
| `src/entities/desktopBox/windows.ts` | Box 创建后调用（幂等、失败降级为普通顶层窗口） |

---

## 5. 被否决的方案（记录以免重蹈）

### 5.1 WorkerW 吸附（Wallpaper Mode）— 架构性失败

把 Box `SetParent` 到 Explorer 的 `WorkerW` 桌面层（Wallpaper Engine 同款技术）。
`WorkerW` 在 Z 序上位于桌面图标层 `SHELLDLL_DefView` **之下**，鼠标命中测试到不了它，
Box「无法点击、无法拖放」；`WS_EX_LAYERED` 子窗口的 alpha 合成同时异常，出现黑角。
要让壁纸窗口收输入需要额外做 raw-input 转发（`RIDEV_INPUTSINK` 全局钩子），对
WebView2 的 Chromium 输入管道极不友好。

> Rainmeter 在 2010 年（commit `b769a7a3`）也正是**移除**了这条路线
> （删掉 `SetParent(m_Window, ProgmanHwnd)`），改为纯粹的 Z 序管理。

### 5.2 Pin Mode（常驻 `HWND_TOPMOST`）— 违反需求 5

```rust
SetWindowPos(hwnd, Some(HWND_TOPMOST), ...);          // 置顶
SetWindowLongPtrW(hwnd, GWLP_WNDPROC, pin_wndproc);   // 子类化
```

置顶窗口天然免疫 Win+D / Win+M，交互也完全正常，但**必然盖住所有普通应用窗口**。
需求 4（不遮挡设置窗）只能靠「让设置窗也进置顶带并排在 Box 之前」打补丁，
对其它应用一概无解。

**顺带记录一条被推翻的结论**：早期认为「子类化拦截对普通层级无效」是因为
`decoration: false` + `skipTaskbar: true`（映射为 `WS_EX_TOOLWINDOW`）的窗口收不到
Win+D 的 `WM_WINDOWPOSCHANGING`。该观察本身成立，但**方向错了**——Rainmeter 的方案
根本不依赖收到那条消息，而是靠 Z 序状态检测 + 主动排层。所以「窗口样式」不是关键，
「能不能观测到桌面状态」才是。

---

## 6. 已知限制与可选扩展

1. **Box 无法被最小化**：`SC_MINIMIZE` 被吞掉（需求 3 的代价），包括任务栏右键、
   `Alt+Space` 菜单里的最小化。后续若要做成配置项，在 `box_wndproc` 按配置放行即可。
2. **Box 被任何窗口覆盖时需先让开才能点击**：这是「On Desktop」语义的固有属性
   （桌面小组件的行为），Rainmeter 的同类档位 `-1` / `-2` 完全一致。
3. **Win+D 后 Box 回归有 ≤150ms 延迟**：纯轮询换取的实现简单度。若要消除可见闪烁，
   可加 `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)` 钩子（Rainmeter 的做法：
   `System::MyWinEventProc`），在前台窗口变成桌面宿主时立即触发一次检测。
   轮询仍需保留作为兜底。
4. **档位可配置**：若后续要提供「始终置顶」给便签型用法，Z 序目标已集中在
   `apply_box_band` 一处，扩展为按配置选择即可。
5. **多桌面/虚拟桌面切换**：当前未处理（Rainmeter 同样不做）。若需要，可监听
   `EVENT_SYSTEM_DESKTOPSWITCH`。

---

## 7. 自主验证方法

```powershell
$env:DASKTOP_BOX_DIAG = "1"
pnpm tauri dev
notepad $env:TEMP\dasktop-box-diag.log
```

`desktop_glue` 会记录：Box 固定时的初始桌面状态、每次状态翻转（`SHOWN` / `NORMAL`）、
每次层级落点（`HWND_BOTTOM` 或置顶带最底部）、拦截到的哨兵移动与 `SC_MINIMIZE`。

验收标准：

| 操作 | 期望 |
|---|---|
| 正常运行 | Box 可见；打开任意应用窗口盖住它所在位置 → 应用在上，Box 被盖住；设置窗不被 Box 遮挡 |
| Win+D | ≤150ms 内 Box 仍可见于桌面，且**低于**任务栏；日志出现 `desktop state -> SHOWN` |
| 再按 Win+D | Box 回到所有应用窗之下；日志出现 `desktop state -> NORMAL` |
| Win+M | Box 保持可见；日志出现 `intercepted SC_MINIMIZE` |
| 点击 Box 后 | Box **不会**浮到其它应用之上 |
| 拖动 / 拖放文件到 Box | 正常 |
