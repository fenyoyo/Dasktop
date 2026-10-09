# 求助：Box 窗口「常驻桌面」与「不遮挡其它窗口」能否兼得

> 面向熟悉 Win32 窗口管理 / DWM 的同学。本文描述已实现方案、已解决的问题，
> 以及**卡住的核心疑问**。代码可直接编译运行，欢迎实测给结论。

---

## 1. 需求

Box 是 Dasktop 的桌面小组件（Tauri 2 + WebView2，透明无边框顶层窗口），期望行为：

1. **常驻桌面**：悬浮在桌面图标之上，可交互（点击打开应用、拖放文件）。
2. **Win+D（显示桌面）时保持可见**，不被隐藏。
3. **Win+M（全部最小化）时保持可见**。
4. **不遮挡主窗口（设置窗口）**。
5. **尽量不遮挡其它应用窗口**（浏览器、编辑器等）。

其中 1–4 已实现，5 是**当前未解决的难点**。

---

## 2. 已走过的两条路（含失败结论，避免重复踩坑）

### 2.1 WorkerW 吸附（Wallpaper Mode）— 已弃用

把 Box `SetParent` 到 Explorer 的 WorkerW 桌面层（Wallpaper Engine 同款技术）。

**失败原因（架构性，非代码 bug）**：

- WorkerW 在 Z 序上位于桌面图标层 `SHELLDLL_DefView` **之下**，鼠标命中测试到不了
  它，导致 Box「无法点击、无法拖放」。这正是 `tauri-plugin-wallpaper` 文档明确的
  限制：*wallpaper windows normally receive no input*。要让它交互需要额外做
  raw-input 转发（`RIDEV_INPUTSINK` 全局钩子），对 WebView2 的 Chromium 输入管道极不友好。
- 附带问题：`WS_EX_LAYERED` 子窗口在 WorkerW 下 alpha 合成异常，出现黑角。

### 2.2 Pin Mode 置顶（当前方案）— 已实现，但有副作用

```rust
// src-tauri/src/infrastructure/windows/desktop_glue.rs
SetWindowPos(hwnd, Some(HWND_TOPMOST), ...);           // 置顶
SetWindowLongPtrW(hwnd, GWLP_WNDPROC, pin_wndproc);     // 子类化
```

子类化回调拦截两类消息：

- `WM_WINDOWPOSCHANGING` 且 `x == -32000` → 加 `SWP_NOMOVE | SWP_NOSIZE` 阻止移动；
- `WM_SYSCOMMAND` 且 `wparam & 0xFFF0 == SC_MINIMIZE` → 直接 `return 0`（免疫 Win+M）。

**结果**：Win+D、Win+M 都免疫，交互完全正常（Box 仍是普通顶层窗口，WebView2 输入链不受影响）。

**副作用**：`HWND_TOPMOST` 意味着 Box 盖住**所有**普通应用窗口（需求 5 不满足）。

---

## 3. 已解决：Box 遮挡主窗口

思路：Box 必须留在置顶层（否则失去 Win+D 免疫），所以**不能靠降低 Box 层级让路**，
改为让主窗口也进入置顶层并排在 Box 之前。

```rust
// 设置窗显示/聚焦时
SetWindowPos(settings, HWND_TOPMOST, ...);           // 设置窗进入置顶层
for box in pinned_boxes {
    SetWindowPos(box, settings, ...);                // Box 插到设置窗之后（下方）
}
// 设置窗隐藏/失焦时
for box in pinned_boxes { SetWindowPos(box, HWND_TOPMOST, ...); }
SetWindowPos(settings, HWND_NOTOPMOST, ...);         // 设置窗退出置顶层
```

两者都在置顶层 → 都保留 Win+D 免疫；Z 序上设置窗在上 → 不被遮挡。
挂载点：`src-tauri/src/infrastructure/tauri/tray/window.rs`（显示、关闭、焦点变化三处）。

---

## 4. 卡住的核心疑问（重点求助）

### Q1：Win+D 到底靠什么机制隐藏窗口？

我观察到的现象：

- **置顶窗口不被 Win+D 隐藏**（这是当前方案成立的前提）。
- 非置顶窗口会被移到哨兵坐标 `(-32000, -32000)`，这正是代码中拦截 `x == -32000` 的依据。

想确认的是：**Win10/11 上 Win+D 的确切实现路径是什么？**

- 是 Explorer 枚举顶层窗口并 `SetWindowPos(-32000)`，同时**跳过 `WS_EX_TOPMOST`**？
- 还是走了 DWM 的 cloak / `DwmSetWindowAttribute`？
- 有没有官方或逆向结论可引用？

### Q2（最关键）：非置顶窗口，能否仅靠拦截 `WM_WINDOWPOSCHANGING` 免疫 Win+D？

如果答案是**能**，那么 Box 可以不做 `HWND_TOPMOST`，需求 5 迎刃而解：
Box 是普通层级窗口 → 不遮挡任何应用 → 激活其它应用时其它应用自然在它之上。

我目前的证据是**不确定的**：

- 早期实测过「只拦截、不置顶」，结论是**无效**（Box 仍被隐藏）；
- 但那次实测与现在的 `pin_wndproc` 实现有差异（当时拦截逻辑更简单），
  **不能排除是当时代码的问题而非机制不允许**。

**已内置实验开关用于验证**（无需改代码）：

```bash
# Windows PowerShell
$env:DASKTOP_BOX_NO_TOPMOST = "1"
pnpm tauri dev
```

设置后 Box 不进入置顶层，只保留子类化拦截。请直接按 Win+D 观察：

- **Box 仍保留** → 说明普通层级也能免疫，本方案可去掉置顶，需求 5 达成；
- **Box 消失了** → 说明 `HWND_TOPMOST` 是必需条件，需求 5 与需求 2 在 Win32 语义上冲突。

### Q3：如果 Q2 答案为「不能」，还有别的路吗？

目标：窗口处于普通 Z 序（不遮挡应用），但 Win+D 不隐藏它。

- 能不能拦截 Explorer 的 ToggleDesktop 行为（例如 `IShellDispatch4::ToggleDesktop`
  相关的消息/COM 调用）？
- 能否在 Win+D 后立刻（例如监听 `EVENT_SYSTEM_DESKTOPSWITCH` 或 Shell 钩子）把窗口
  恢复显示？会不会有闪烁？
- 现成软件是怎么做的：Windows 11 便签（Sticky Notes）、Rainmeter、DesktopCoral、
  Lively Wallpaper —— 它们是置顶还是普通层级？便签按 Win+D 时会消失吗？
  （如果便签也会消失，说明这是系统级限制，需求 2 与 5 不可兼得。）

### Q4：产品层面的取舍建议

如果确认 2 与 5 不可兼得，更合理的产品形态是什么？目前想到的几种：

- A：保持置顶（当前），接受遮挡其它应用 —— 便签类小组件的常见做法；
- B：取消置顶，Win+D 时跟随隐藏 —— 退化成「普通窗口」；
- C：置顶，但检测到有全屏/最大化应用时自动隐藏 Box；
- D：交由用户在设置里选择 A / B（代码里已预留：在 `pin_wndproc` 按配置决定是否
  放行；在 `glue_box_window_to_desktop` 决定是否置顶）。

---

## 5. 相关代码位置

| 文件 | 作用 |
|---|---|
| `src-tauri/src/infrastructure/windows/desktop_glue.rs` | 置顶、子类化拦截、Z 序管理（核心） |
| `src-tauri/src/services/app/box_window_glue.rs` | 校验 label、工作线程解析 hwnd、调度主线程 |
| `src-tauri/src/commands/box_window.rs` | Tauri 命令入口 |
| `src-tauri/src/infrastructure/tauri/tray/window.rs` | 设置窗显示/隐藏/焦点时的层级同步 |
| `src/entities/desktopBox/windows.ts` | 前端在 Box 创建后调用固定（幂等、失败降级） |

---

## 6. 复现环境

- Windows 11，Tauri 2.11，WebView2
- 分支：`feat/box-pin-win-d`
- 运行：`pnpm tauri dev`（加 `$env:DASKTOP_BOX_NO_TOPMOST="1"` 可切换实验模式）
