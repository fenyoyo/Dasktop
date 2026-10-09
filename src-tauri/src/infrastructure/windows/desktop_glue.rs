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
//! Win+M（Minimize All）向窗口发 `WM_SYSCOMMAND + SC_MINIMIZE`。本实现同样拦截
//! 该消息（返回 0 不转发），使 Box 在 Win+M 时也保持可见——Box 是「常驻桌面」
//! 语义，用户按 Win+M 清桌面时它也应留存。
//!
//! 注意：拦截 SC_MINIMIZE 会让 Box **无法通过任何方式最小化**（包括点任务栏
//! 图标、点窗口自带的最小化按钮）。后续若要做「用户可选」，可在此处按配置
//! 决定是否放行 SC_MINIMIZE。
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
    HWND_NOTOPMOST, HWND_TOPMOST, SC_MINIMIZE, SET_WINDOW_POS_FLAGS, SWP_NOACTIVATE, SWP_NOMOVE,
    SWP_NOSIZE, WINDOWPOS, WM_SYSCOMMAND, WM_WINDOWPOSCHANGING, WNDPROC,
};

/// 已固定（pin）的 Box 窗口 → 原窗口过程指针（isize 存储规避裸指针跨容器所有权歧义）。
/// 用于 `pin_wndproc` 把消息转发回原窗口过程，以及幂等判断是否已固定。
static PINNED_BOXES: OnceLock<Mutex<HashMap<isize, isize>>> = OnceLock::new();

/// 当前被临时提升到 Box 之上的窗口（设置窗口）。Box 保持置顶不变，这里只记录
/// 「谁应该在 Box 之上」，供新 Box 固定时维持相对顺序、以及恢复时降级该窗口。
static RAISED_WINDOW: OnceLock<Mutex<Option<isize>>> = OnceLock::new();

/// 置顶层窗口位置调整统一标志：只改 Z 序，不动位置、尺寸和激活状态。
///
/// `SWP_*` 在 windows crate 里是 newtype，取 `.0` 后再包装成 `SET_WINDOW_POS_FLAGS`
/// 才能在 const 上下文中拼接。
const ZORDER_ONLY: SET_WINDOW_POS_FLAGS =
    SET_WINDOW_POS_FLAGS(SWP_NOMOVE.0 | SWP_NOSIZE.0 | SWP_NOACTIVATE.0);

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
        // 1. 进入置顶层（置顶窗口天然不被 Win+D 隐藏）。
        //    若此刻有窗口正被提升到 Box 之上（设置窗口已打开），则把新 Box 插到
        //    它下方，避免刚创建的 Box 盖住已打开的设置窗口。
        let insert_after = if topmost_disabled() {
            HWND_NOTOPMOST
        } else {
            current_raised_window().unwrap_or(HWND_TOPMOST)
        };
        SetWindowPos(hwnd, Some(insert_after), 0, 0, 0, 0, ZORDER_ONLY)
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

/// 把指定窗口提升到所有已固定 Box 之上，解决「Box 置顶挡住主窗口」的问题。
///
/// Box 必须保持置顶层才能免疫 Win+D/Win+M，因此不能靠降低 Box 层级来让路；
/// 正确做法是让目标窗口**也进入置顶层，并排在 Box 前面**：
///
/// 1. 目标窗口 `SetWindowPos(HWND_TOPMOST)` 进入置顶层；
/// 2. 把每个已固定的 Box `SetWindowPos` 插到目标窗口之后（即其下方）。
///
/// 两者都在置顶层，因而都保留 Win+D 免疫；Z 序上目标窗口在上，不再被挡。
///
/// 必须在窗口归属线程（主线程）调用。
pub fn raise_window_above_boxes(hwnd: HWND) {
    // 实验开关下 Box 是普通层级，设置窗激活后自然在它之上，无需额外排序。
    if topmost_disabled() {
        return;
    }
    if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
        return;
    }

    RAISED_WINDOW
        .get_or_init(Default::default)
        .lock()
        .expect("pin mutex poisoned")
        .replace(hwnd.0 as isize);

    // SAFETY: hwnd 与已记录的 Box 句柄均有效，调用在主线程。
    unsafe {
        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, ZORDER_ONLY);
        // Box 插到目标窗口之后 → 位于其下方。
        for box_hwnd in pinned_box_handles() {
            let _ = SetWindowPos(box_hwnd, Some(hwnd), 0, 0, 0, 0, ZORDER_ONLY);
        }
    }
}

/// 撤销 `raise_window_above_boxes`：Box 回到置顶层顶部，目标窗口退出置顶层。
///
/// 设置窗口隐藏时调用，避免它长期占据置顶层挡住其它应用。
pub fn restore_boxes_on_top() {
    if topmost_disabled() {
        return;
    }
    let raised = RAISED_WINDOW
        .get()
        .and_then(|slot| slot.lock().expect("pin mutex poisoned").take());

    // SAFETY: 句柄来自本模块记录，调用在主线程。
    unsafe {
        for box_hwnd in pinned_box_handles() {
            let _ = SetWindowPos(box_hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, ZORDER_ONLY);
        }
        if let Some(raw) = raised {
            let hwnd = HWND(raw as *mut _);
            if IsWindow(Some(hwnd)).as_bool() {
                let _ = SetWindowPos(hwnd, Some(HWND_NOTOPMOST), 0, 0, 0, 0, ZORDER_ONLY);
            }
        }
    }
}

/// 读取当前被提升到 Box 之上的窗口；窗口已销毁或从未提升时返回 None。
fn current_raised_window() -> Option<HWND> {
    let raw = RAISED_WINDOW
        .get()
        .and_then(|slot| *slot.lock().expect("pin mutex poisoned"))?;
    let hwnd = HWND(raw as *mut _);
    // SAFETY: 句柄来自本模块记录，IsWindow 判定其是否仍有效。
    unsafe { IsWindow(Some(hwnd)) }.as_bool().then_some(hwnd)
}

/// 实验开关：置 `1` 时 Box 不进入置顶层，仅靠子类化拦截免疫 Win+D。
///
/// 用于验证「去掉 `HWND_TOPMOST` 后 Win+D 免疫是否仍成立」。这决定了 Box 能否做到
/// 「既不遮挡任何应用窗口，又在显示桌面时保留」——置顶层必然遮挡其它应用，只有
/// 证明普通层级也能免疫，才能彻底解决遮挡。验证结论出来后由设置项取代本开关。
fn topmost_disabled() -> bool {
    std::env::var("DASKTOP_BOX_NO_TOPMOST")
        .map(|value| value == "1")
        .unwrap_or(false)
}

/// 快照当前所有已固定 Box 的句柄，避免在持锁状态下调用 Win32（可能重入）。
fn pinned_box_handles() -> Vec<HWND> {
    PINNED_BOXES
        .get()
        .map(|pinned| {
            pinned
                .lock()
                .expect("pin mutex poisoned")
                .keys()
                .map(|raw| HWND(*raw as *mut _))
                .collect()
        })
        .unwrap_or_default()
}

/// 拦截两类消息，让 Box 在「显示桌面」和「全部最小化」时都保持可见：
///
/// - `WM_WINDOWPOSCHANGING`：阻止 Win+D 把窗口移到 (-32000, -32000)，并强制
///   保持置顶。Win+D 的机制是向所有**普通 Z 序**窗口发该消息尝试把它们移到
///   哨兵坐标。置顶窗口通常不参与，但作为兜底，这里在收到该消息时阻止移动
///   并强制 `HWND_TOPMOST`。
/// - `WM_SYSCOMMAND + SC_MINIMIZE`：Win+M 及一切最小化命令。直接返回 0 不转发，
///   窗口保持可见，不进入最小化状态。
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
    } else if msg == WM_SYSCOMMAND && wparam.0 as u32 & 0xFFF0 == SC_MINIMIZE {
        // 拦截 Win+M（及最小化命令）：Box 常驻桌面，不响应最小化。
        // 直接返回 0 表示已处理，不转发给原窗口过程，窗口保持可见。
        return LRESULT(0);
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
