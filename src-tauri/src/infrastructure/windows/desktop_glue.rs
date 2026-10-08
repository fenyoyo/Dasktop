//! Box 窗口的「桌面置顶固定」（Pin Mode）：让 Box 保持置顶并免受 Win+D「显示桌面」影响。
//!
//! # 背景
//!
//! Box 的产品语义是「常驻桌面的小组件」（悬浮在桌面图标之上、可交互）。
//! Win+D「显示桌面」会把所有普通 Z 序窗口隐藏，Box 也跟着消失。
//!
//! # 为什么不用 WorkerW 吸附（Wallpaper Mode）
//!
//! 之前尝试把 Box `SetParent` 到 WorkerW 桌面层（Wallpaper Engine 同款技术），
//! 实测发现**两个致命问题**：
//!
//! 1. **收不到输入**：WorkerW 窗口在 Z 序上位于桌面图标层（`SHELLDLL_DefView`）
//!   之下，鼠标命中测试根本到不了它，导致 Box「无法点击、无法拖放」。这是
//!   `tauri-plugin-wallpaper` 官方文档明确指出的限制——壁纸窗口默认收不到输入，
//!   要让它们交互需要额外的 raw-input 转发（`RIDEV_INPUTSINK` 全局原始输入钩子），
//!   复杂度高且 Chromium 的输入管道对合成消息不友好。
//! 2. **黑角/样式失真**：`WS_EX_LAYERED` 子窗口在 WorkerW 下 alpha 合成异常。
//!
//! # 本方案：Pin Mode（置顶 + 拦截 WM_WINDOWPOSCHANGING）
//!
//! 正确做法（`tauri-plugin-wallpaper` 的 Pin Mode 同款）是**保持 Box 为普通顶层
//! 窗口，但置顶**：
//!
//! 1. `SetWindowPos(HWND_TOPMOST)` 把 Box 置顶。置顶窗口**天然不被 Win+D 隐藏**
//!    （Win+D 只作用于普通 Z 序窗口），这是核心机制；
//! 2. 子类化窗口过程，拦截 `WM_WINDOWPOSCHANGING`：当系统尝试把窗口移到
//!   `(-32000, -32000)`（Win+D 的哨兵坐标）时，设置 `SWP_NOMOVE | SWP_NOSIZE`
//!   阻止移动，并强制 `hwndInsertAfter = HWND_TOPMOST`，兜底某些边缘场景。
//!
//! 这样 Box 既是**普通顶层窗口**（WebView2 输入链完全正常，点击/拖放/激活都
//! 正常），又能**在 Win+D 时保持可见**。
//!
//! # 与 Win+M 的关系
//!
//! Win+M（Minimize All）向窗口发 `WM_SYSCOMMAND + SC_MINIMIZE`，会正常最小化
//! 置顶窗口。Box 是否要响应 Win+M 属于产品决策；本实现只处理 Win+D，不改动
//! Win+M 的默认最小化行为。
//!
//! # 边界与降级
//!
//! - 子类化窗口过程必须保存原过程指针，并在窗口销毁/取消固定时恢复；
//! - 置顶是纯窗口属性操作，无 UIPI 限制（不跨进程），以管理员运行也安全。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, DefWindowProcW, IsWindow, SetWindowLongPtrW, SetWindowPos, GWLP_WNDPROC,
    HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE, WINDOWPOS, WM_WINDOWPOSCHANGING, WNDPROC,
};

/// 已固定（pin）的 Box 窗口 → 原窗口过程指针（isize 存储规避裸指针跨容器所有权歧义）。
/// 用于 `pin_wndproc` 把消息转发回原窗口过程，以及幂等判断是否已固定。
static PINNED_BOXES: OnceLock<Mutex<HashMap<isize, isize>>> = OnceLock::new();

/// 把 Box 窗口固定为「置顶 + 免疫 Win+D」。
///
/// 必须在窗口归属线程（主线程）调用。失败只返回错误描述，由服务层决定
/// 是否降级（普通顶层窗口）或记录日志。
pub fn glue_box_window_to_desktop(hwnd: HWND) -> Result<(), String> {
    if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
        return Err("窗口句柄已失效".to_string());
    }

    // 幂等：已固定则直接返回。
    let raw = hwnd.0 as isize;
    if let Some(pinned) = PINNED_BOXES.get() {
        if pinned.lock().expect("pin mutex poisoned").contains_key(&raw) {
            return Ok(());
        }
    }

    // SAFETY: hwnd 有效，调用在主线程。置顶 + 子类化窗口过程。
    unsafe {
        // 1. 置顶（置顶窗口天然不被 Win+D 隐藏）。
        SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE,
        )
        .map_err(|error| format!("SetWindowPos 置顶失败: {error}"))?;

        // 2. 子类化窗口过程，拦截 WM_WINDOWPOSCHANGING 兜底。
        let original_wndproc =
            SetWindowLongPtrW(hwnd, GWLP_WNDPROC, pin_wndproc as *const () as isize);
        if original_wndproc == 0 {
            return Err("子类化窗口过程失败".to_string());
        }

        PINNED_BOXES
            .get_or_init(Default::default)
            .lock()
            .expect("pin mutex poisoned")
            .insert(raw, original_wndproc);
    }

    Ok(())
}

/// 拦截 `WM_WINDOWPOSCHANGING`：阻止 Win+D 把窗口移到 (-32000, -32000)，
/// 并强制保持置顶。
///
/// Win+D 的机制是向所有**普通 Z 序**窗口发 `WM_WINDOWPOSCHANGING` 尝试把它们
/// 移到哨兵坐标 (-32000, -32000)。置顶窗口通常不参与，但作为兜底，这里在
/// 收到该消息时阻止移动并强制 `HWND_TOPMOST`。
unsafe extern "system" fn pin_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_WINDOWPOSCHANGING {
        // SAFETY: WM_WINDOWPOSCHANGING 的 lparam 指向 WINDOWPOS 结构。
        let pos = lparam.0 as *mut WINDOWPOS;
        if !pos.is_null() {
            let pos_ref = unsafe { &mut *pos };
            if pos_ref.x == -32000 {
                // 阻止 Win+D 的哨兵移动，并强制保持置顶。
                pos_ref.flags |= SWP_NOMOVE | SWP_NOSIZE;
            }
            pos_ref.hwndInsertAfter = HWND_TOPMOST;
        }
    }

    // 转发给原窗口过程。
    let original = PINNED_BOXES
        .get()
        .and_then(|pinned| {
            pinned
                .lock()
                .expect("pin mutex poisoned")
                .get(&(hwnd.0 as isize))
                .copied()
        })
        .map(|ptr| unsafe { std::mem::transmute::<isize, WNDPROC>(ptr) });

    match original {
        Some(original) => CallWindowProcW(original, hwnd, msg, wparam, lparam),
        None => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}
