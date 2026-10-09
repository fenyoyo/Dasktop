//! Box 窗口的「桌面层」（On Desktop）Z 序管理。
//!
//! # 目标
//!
//! Box 的产品语义是「常驻桌面的小组件」，需要同时满足两个约束：
//!
//! 1. **不遮挡任何窗口**：Box 不能浮在浏览器 / 编辑器 / 设置窗之上；
//! 2. **显示桌面时保留**：Win+D、任务栏「显示桌面」之后 Box 仍在桌面上可见可交互。
//!
//! 这两个约束本质互斥——任何「永远在最上层」的实现都必然遮挡其它窗口。
//!
//! # 走错的路线（记录以免重蹈）
//!
//! - **Wallpaper Mode（`SetParent` 到 `WorkerW` / `Progman`）**：`WorkerW` 在 Z 序上
//!   位于桌面图标层 `SHELLDLL_DefView` 之下，鼠标命中测试根本到不了它，Box 无法点击、
//!   无法接收拖放；`WS_EX_LAYERED` 子窗口的 alpha 合成同时会异常。Rainmeter 在 2010 年
//!   （commit `b769a7a3`）也正是**移除**了这条路线，改为纯 Z 序管理。
//! - **Pin Mode（常驻 `HWND_TOPMOST`）**：置顶窗口天然免疫 Win+D，但代价是永远压在
//!   所有窗口之上，直接违反约束 1。只能靠「让设置窗也进置顶带并排在 Box 之前」打补丁，
//!   对其它应用一概无解。
//!
//! # 采用的模型：Rainmeter 的 `AlwaysOnTop = -2`（On Desktop）
//!
//! 参考 `E:\github\rainmeter`（`Library/System.cpp` 的 `System::CheckDesktopState` /
//! `PrepareHelperWindow`，`Library/Skin.cpp` 的 `Skin::ChangeZPos`），Rainmeter 用
//! 两层状态实现同一语义：
//!
//! | 状态 | Box 的 Z 序位置 | 效果 |
//! |---|---|---|
//! | 普通 | `HWND_BOTTOM` | 在所有应用窗口之下、桌面图标之上 → 永不遮挡 |
//! | 显示桌面 | 置顶带**最底部** | 高于被提升的桌面，低于任务栏等真置顶窗口 → 保留可见 |
//!
//! 关键在于**桌面宿主窗口的 Z 序位置会变化**：按 Win+D 时 Explorer 把桌面图标宿主
//! （Win11 24H2+ 是 `Progman`；更早版本是承载 `SHELLDLL_DefView` 的 `WorkerW`）
//! 从 Z 序最底层**提升到非置顶带的顶端**。因此 Box 只放在 `HWND_BOTTOM` 是不够的——
//! 桌面一旦被提升，Box 就落到桌面之下被「吞掉」；必须同时把它搬进置顶带。
//!
//! 检测「桌面是否被提升」用的是纯 Z 序几何判据（见 `desktop_is_frontmost`），
//! 不依赖窗口焦点，所以点击 Box、点击桌面图标都不会误判。
//!
//! 子类化的窗口过程（见 `box_wndproc`）负责两件事：
//!
//! - `WM_WINDOWPOSCHANGING` 强制 `SWP_NOZORDER`：Box 不参与 Z 序竞争，点击 / 激活
//!   都不会把它抬到其它窗口之上——这是 Rainmeter 文档里「On Desktop 不能被带到前台」
//!   的实现方式；顺带拦截 Win+D 的哨兵移动 `(-32000, -32000)` 作为兜底；
//! - `WM_SYSCOMMAND + SC_MINIMIZE` 直接吞掉：Win+M「全部最小化」时 Box 保持可见。
//!   代价是 Box 无法通过任何方式最小化。
//!
//! 本模块**自己**的排层调用必须带 `SWP_NOSENDCHANGING`，否则会被上面那条拦截逻辑挡回来。

use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, DefWindowProcW, FindWindowExW, GetShellWindow, GetTopWindow, GetWindow,
    GetWindowLongPtrW, IsWindow, IsWindowVisible, SetWindowLongPtrW, SetWindowPos, GWLP_WNDPROC,
    GWL_EXSTYLE, GW_HWNDNEXT, GW_HWNDPREV, HWND_BOTTOM, HWND_TOPMOST, SC_MINIMIZE,
    SET_WINDOW_POS_FLAGS, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSENDCHANGING,
    SWP_NOSIZE, SWP_NOZORDER, WINDOWPOS, WM_SYSCOMMAND, WM_WINDOWPOSCHANGING, WNDPROC,
    WS_EX_TOPMOST,
};

/// 已固定的 Box 窗口 → 原窗口过程指针。
///
/// 存 `isize` 而非裸指针，规避「裸指针跨容器 + 跨线程」的所有权/`Send` 歧义；
/// 用途有二：把消息转发回原窗口过程，以及幂等判断是否已固定。
static PINNED_BOXES: OnceLock<Mutex<HashMap<isize, isize>>> = OnceLock::new();

/// 最近一次探测到的「显示桌面」状态。
///
/// 用于两件事：诊断日志只在状态翻转时输出；以及判断是否需要在「Box 实际层级与
/// 目标不符」时补一次排层（覆盖 Explorer / 其它应用扰动 Z 序的情况）。
static DESKTOP_SHOWN: AtomicBool = AtomicBool::new(false);

/// 诊断日志开关（`DASKTOP_BOX_DIAG=1`）的缓存值。
static DIAG_ENABLED: OnceLock<bool> = OnceLock::new();

/// 只改 Z 序的窗口位置标志：不动位置 / 尺寸 / 激活状态。
///
/// - `SWP_NOOWNERZORDER`：不连带调整 owner 窗口的 Z 序；
/// - `SWP_NOSENDCHANGING`：**关键**。它抑制 `WM_WINDOWPOSCHANGING`，让本模块自己的
///   排层调用绕过 `box_wndproc` 里「强制 `SWP_NOZORDER`」的拦截——
///   否则 Box 永远无法离开底层，也无法进入置顶带。
///
/// `SWP_*` 在 windows crate 里是 newtype，取 `.0` 后再包装成 `SET_WINDOW_POS_FLAGS`
/// 才能在 const 上下文中拼接。
const ZORDER_ONLY: SET_WINDOW_POS_FLAGS = SET_WINDOW_POS_FLAGS(
    SWP_NOMOVE.0 | SWP_NOSIZE.0 | SWP_NOACTIVATE.0 | SWP_NOOWNERZORDER.0 | SWP_NOSENDCHANGING.0,
);

/// Z 序链遍历上限，防御异常环境（Z 序环、超长链）下的死循环。
const Z_ORDER_WALK_LIMIT: usize = 4000;

/// Win+D 把「可最小化窗口」挪到屏幕外时使用的哨兵坐标。
const MINIMIZE_SENTINEL: i32 = -32000;

/// 把 Box 窗口固定到「桌面层」，使其不遮挡其它窗口、且在显示桌面时保持可见。
///
/// 必须在窗口归属线程（主线程）调用。失败只返回错误描述，由服务层决定是否降级
/// （保留 Tauri 默认的普通顶层窗口行为）或记录日志。
pub fn glue_box_window_to_desktop(hwnd: HWND) -> Result<(), String> {
    if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
        return Err("窗口句柄已失效".to_string());
    }

    // 幂等：已固定则直接返回。
    let raw = hwnd.0 as isize;
    if let Some(pinned) = PINNED_BOXES.get() {
        if pinned
            .lock()
            .expect("pin mutex poisoned")
            .contains_key(&raw)
        {
            return Ok(());
        }
    }

    // SAFETY: hwnd 有效，调用在主线程。子类化窗口过程 + 调整 Z 序。
    unsafe {
        // 1. 先装拦截器，再做首次排层。
        //    首次排层使用的标志含 SWP_NOSENDCHANGING，因此不会触发刚装上的拦截逻辑。
        let original_wndproc =
            SetWindowLongPtrW(hwnd, GWLP_WNDPROC, box_wndproc as *const () as isize);
        if original_wndproc == 0 {
            return Err("子类化窗口过程失败".to_string());
        }

        PINNED_BOXES
            .get_or_init(Default::default)
            .lock()
            .expect("pin mutex poisoned")
            .insert(raw, original_wndproc);

        // 2. 首次排层：按当前桌面状态落到正确层级。
        let desktop_shown = desktop_is_frontmost();
        DESKTOP_SHOWN.store(desktop_shown, Ordering::SeqCst);
        apply_box_band(hwnd, desktop_shown);

        diag_log(&format!(
            "pinned box hwnd=0x{raw:X} desktop_shown={desktop_shown}"
        ));
    }

    Ok(())
}

/// 是否还有存活的已固定 Box（供监视器跳过空转）。
pub fn has_pinned_boxes() -> bool {
    !live_pinned_boxes().is_empty()
}

/// 只读探测当前是否处于「显示桌面」状态。**任意线程可安全调用**。
///
/// 拆出来专供轮询线程做「廉价预检」：在轮询线程直接判定状态，只有状态真的翻转时
/// 才把排层动作投递到主线程，这样即使把轮询频率提到帧率级也不会淹没主线程事件队列。
pub fn probe_desktop_shown() -> bool {
    desktop_is_frontmost()
}

/// 当前已生效的层级状态（`true` = Box 应处于置顶带）。
pub fn current_band_state() -> bool {
    DESKTOP_SHOWN.load(Ordering::SeqCst)
}

/// 把所有 Box 的层级同步到给定桌面状态。**必须在主线程调用。**
///
/// 由状态轮询线程在「检测到翻转」或「到达兜底周期」时投递执行。
pub fn apply_desktop_band(desktop_shown: bool) {
    let boxes = live_pinned_boxes();
    if boxes.is_empty() {
        return;
    }

    let state_changed = DESKTOP_SHOWN.swap(desktop_shown, Ordering::SeqCst) != desktop_shown;
    if state_changed {
        diag_log(&format!(
            "desktop state -> {}",
            if desktop_shown { "SHOWN" } else { "NORMAL" }
        ));
    }

    for box_hwnd in boxes {
        // 状态翻转时无条件纠正；此外只要 Box 的实际「置顶与否」与目标不符就补一次，
        // 覆盖 Explorer 或其它应用扰动 Z 序、把 Box「甩」出目标层级的情况。
        if state_changed || is_topmost(box_hwnd) != desktop_shown {
            apply_box_band(box_hwnd, desktop_shown);
        }
    }
}

/// 判断桌面是否被提升到最前（即处于「显示桌面」状态）。
///
/// 判据（Win11 24H2 实机验证）：
///
/// > 从 Z 序顶端向下遍历，遇到的**第一个「可见且非置顶」的顶层窗口**就是桌面宿主。
///
/// 普通状态下桌面宿主被 Explorer 钉在 Z 序最底层，遍历必然先撞上普通应用窗口而返回
/// `false`；显示桌面时上方只剩置顶窗口（任务栏、本应用置顶窗口等）与不可见辅助窗口
/// （IME / MSCTFIME UI 之类），于是会撞到桌面宿主本身而返回 `true`。
///
/// 该判据只看 Z 序几何、不看焦点，因此点击 Box 或点击桌面图标都不会误判——
/// 这正是它优于 `GetForegroundWindow()` 比较的地方（后者会在用户点到 Box 时误判）。
/// Rainmeter 的 `System::CheckDesktopState` 用隐藏辅助窗口的相对位置做等价判断。
fn desktop_is_frontmost() -> bool {
    let Some(host) = desktop_icons_host() else {
        return false;
    };

    let Ok(first) = (unsafe { GetTopWindow(None) }) else {
        return false;
    };

    let mut current = first;
    for _ in 0..Z_ORDER_WALK_LIMIT {
        if current == host {
            return true;
        }
        // 可见的非置顶窗口出现在桌面宿主之前 ⇒ 桌面尚未被提升。
        if unsafe { IsWindowVisible(current) }.as_bool() && !is_topmost(current) {
            return false;
        }
        match unsafe { GetWindow(current, GW_HWNDNEXT) } {
            Ok(next) => current = next,
            Err(_) => return false,
        }
    }

    false
}

/// 定位承载桌面图标的宿主窗口。
///
/// - Win11 24H2 起 Explorer 重排了桌面窗口层级，`Progman`（`GetShellWindow()`）直接
///   持有 `SHELLDLL_DefView`（见 Rainmeter 的 `ShouldUseShellWindowAsDesktopIconsHost`，
///   PR #413）；
/// - 更早版本 `SHELLDLL_DefView` 挂在某个全屏 `WorkerW` 下，需要枚举查找。
fn desktop_icons_host() -> Option<HWND> {
    let shell = unsafe { GetShellWindow() };
    if shell.0.is_null() {
        // 默认 Shell（Explorer）未运行，无法判断桌面状态。
        return None;
    }

    if find_child_of_class(shell, w!("SHELLDLL_DefView")).is_some() {
        return Some(shell);
    }

    let mut previous: Option<HWND> = None;
    loop {
        let worker = unsafe { FindWindowExW(None, previous, w!("WorkerW"), PCWSTR::null()) }
            .unwrap_or_default();
        if worker.0.is_null() {
            return None;
        }
        if find_child_of_class(worker, w!("SHELLDLL_DefView")).is_some() {
            return Some(worker);
        }
        previous = Some(worker);
    }
}

/// 在给定窗口的直接子窗口中按类名查找，找不到返回 `None`。
fn find_child_of_class(parent: HWND, class: PCWSTR) -> Option<HWND> {
    let child =
        unsafe { FindWindowExW(Some(parent), None, class, PCWSTR::null()) }.unwrap_or_default();
    (!child.0.is_null()).then_some(child)
}

/// 窗口是否处于置顶层（`WS_EX_TOPMOST`）。
fn is_topmost(hwnd: HWND) -> bool {
    (unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } & WS_EX_TOPMOST.0 as isize) != 0
}

/// 从给定窗口向上查找置顶带里「最靠后」的窗口。
///
/// 显示桌面时桌面宿主位于非置顶带顶端，因此它上方第一个置顶窗口就是置顶带的最底部一员。
/// 把 Box 插到它之后，Box 即成为置顶带最底部窗口：高于被提升的桌面，低于任务栏 /
/// PowerToys 等真正的置顶窗口。找不到时降级为 `HWND_TOPMOST`（置于置顶带顶部）。
fn backmost_topmost_window(from: HWND) -> Option<HWND> {
    let mut current = from;
    for _ in 0..Z_ORDER_WALK_LIMIT {
        current = unsafe { GetWindow(current, GW_HWNDPREV) }.ok()?;
        if is_topmost(current) {
            return Some(current);
        }
    }
    None
}

/// 调整单个 Box 的 Z 序落点：只改层级，不动位置 / 尺寸 / 激活状态。
fn set_box_z(box_hwnd: HWND, insert_after: HWND) {
    // SAFETY: 句柄来自本模块记录，调用发生在主线程。
    match unsafe { SetWindowPos(box_hwnd, Some(insert_after), 0, 0, 0, 0, ZORDER_ONLY) } {
        Ok(()) => diag_log(&format!(
            "box 0x{:X} -> insertAfter=0x{:X} topmost={}",
            box_hwnd.0 as usize,
            insert_after.0 as usize,
            is_topmost(box_hwnd),
        )),
        Err(error) => eprintln!("failed to set box window band: {error}"),
    }
}

/// 把单个 Box 落到与桌面状态匹配的层级。
fn apply_box_band(box_hwnd: HWND, desktop_shown: bool) {
    if !desktop_shown {
        // 普通状态：`HWND_BOTTOM` = 所有窗口之下、桌面图标之上（同时清掉置顶样式）。
        set_box_z(box_hwnd, HWND_BOTTOM);
        return;
    }

    // 显示桌面：必须进置顶带，否则会被提升到最前的桌面盖住。分两步，与 Rainmeter 的
    // `System::PrepareHelperWindow` / `Skin::ChangeZPos` 做法一致：
    //
    // 1. 先显式置顶，真正拿到 `WS_EX_TOPMOST` 样式位。**只把窗口插到「最靠后的置顶窗口」
    //    之后并不会让它变成置顶窗口**——MSDN 的判据是「被排到所有置顶窗口之上」，
    //    插在置顶带下方只会让它留在非置顶带顶端。实测正是这个坑：漏掉这一步时窗口虽然
    //    高于桌面，却不带置顶样式，会被每轮的「样式与目标不符」检查反复重排。
    // 2. 再插到「最靠后的置顶窗口」之后，落到置顶带**最底部**：高于桌面、低于任务栏。
    set_box_z(box_hwnd, HWND_TOPMOST);

    let anchor = desktop_icons_host()
        .and_then(backmost_topmost_window)
        // 第 1 步后 Box 位于置顶带最顶部，理论上不会命中自己；防御性过滤掉。
        .filter(|anchor| *anchor != box_hwnd)
        .unwrap_or(HWND_TOPMOST);
    set_box_z(box_hwnd, anchor);
}

/// 读取当前存活的已固定 Box 句柄，顺带清理已销毁窗口的陈旧记录。
fn live_pinned_boxes() -> Vec<HWND> {
    let Some(pinned) = PINNED_BOXES.get() else {
        return Vec::new();
    };
    let mut pinned = pinned.lock().expect("pin mutex poisoned");

    let dead: Vec<isize> = pinned
        .keys()
        .copied()
        // SAFETY: 只用返回值判断窗口是否仍存在，不解引用任何指针。
        .filter(|raw| !unsafe { IsWindow(Some(HWND(*raw as *mut _))) }.as_bool())
        .collect();
    for raw in dead {
        pinned.remove(&raw);
    }

    pinned.keys().map(|raw| HWND(*raw as *mut _)).collect()
}

/// Box 窗口的替换过程，实现「桌面层」语义所需的全部消息拦截。
///
/// - `WM_WINDOWPOSCHANGING`：
///   1. 强制 `SWP_NOZORDER`——Box 不参与 Z 序竞争（对应 Rainmeter 对
///      `ZPOSITION_ONDESKTOP` 的处理，见 `Skin::OnWindowPosChanging`）。这是
///      「点击它也不会浮到其它窗口之上」的关键；本模块自己的排层调用带
///      `SWP_NOSENDCHANGING`，不会走到这里，因此不影响层级纠正。
///   2. Win+D 若仍向本窗口发哨兵移动 `(-32000, -32000)`，加 `SWP_NOMOVE | SWP_NOSIZE`
///      兜底拦住（样式上本已不该被命中，纯保险）。
/// - `WM_SYSCOMMAND + SC_MINIMIZE`：Win+M「全部最小化」及一切最小化命令。直接返回 0
///   不转发，窗口保持可见。**注意**：这会让 Box 无法通过任何方式最小化。
unsafe extern "system" fn box_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_WINDOWPOSCHANGING {
        // SAFETY: WM_WINDOWPOSCHANGING 的 lparam 指向 WINDOWPOS 结构。
        let pos = lparam.0 as *mut WINDOWPOS;
        if !pos.is_null() {
            let pos = unsafe { &mut *pos };
            if pos.x == MINIMIZE_SENTINEL {
                pos.flags |= SWP_NOMOVE | SWP_NOSIZE;
                diag_log("intercepted Win+D sentinel move");
            }
            pos.flags |= SWP_NOZORDER;
        }
    } else if msg == WM_SYSCOMMAND && wparam.0 as u32 & 0xFFF0 == SC_MINIMIZE {
        diag_log("intercepted SC_MINIMIZE");
        return LRESULT(0);
    }

    // 转发给原窗口过程（Tauri / WebView2 的窗口过程）。
    let original = original_wndproc(hwnd);
    match original {
        Some(original) => unsafe { CallWindowProcW(original, hwnd, msg, wparam, lparam) },
        None => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

/// 取回窗口被替换前的原过程指针。
fn original_wndproc(hwnd: HWND) -> Option<WNDPROC> {
    PINNED_BOXES
        .get()
        .and_then(|pinned| {
            pinned
                .lock()
                .expect("pin mutex poisoned")
                .get(&(hwnd.0 as isize))
                .copied()
        })
        // SAFETY: 指针由 SetWindowLongPtrW 返回，指向该窗口原始的窗口过程。
        .map(|raw| unsafe { std::mem::transmute::<isize, WNDPROC>(raw) })
}

/// 诊断日志文件路径：`%TEMP%\dasktop-box-diag.log`。
fn diag_log_path() -> std::path::PathBuf {
    std::env::temp_dir().join("dasktop-box-diag.log")
}

/// 是否启用诊断日志（`DASKTOP_BOX_DIAG=1`）。读取一次后缓存。
fn diag_enabled() -> bool {
    *DIAG_ENABLED.get_or_init(|| {
        let enabled = std::env::var("DASKTOP_BOX_DIAG")
            .map(|value| value == "1")
            .unwrap_or(false);
        if enabled {
            eprintln!("[desktop_glue] 诊断日志已启用: {}", diag_log_path().display());
        }
        enabled
    })
}

/// 追加一行诊断日志；未启用或写入失败时静默忽略（诊断不得影响主流程）。
///
/// 逐行 open/append/close，避免长驻文件句柄随窗口销毁泄漏；诊断频率低，开销可忽略。
fn diag_log(line: &str) {
    if !diag_enabled() {
        return;
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(diag_log_path())
    {
        let _ = writeln!(file, "{line}");
    }
}
