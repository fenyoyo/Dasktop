//! 把「系统当前前台窗口」切换为置顶 / 取消置顶的 Win32 实现。
//!
//! 宿主在设置页配一个全局快捷键，按下后作用于**任意应用**的前台窗口：它要么浮到所有
//! 窗口之上，要么取消置顶。等价于 PowerToys 的 Always on Top，但不引入新依赖。
//!
//! # 只做 Win32 部分
//!
//! 「本进程里哪些窗口不该被置顶」的判定要按 Tauri 窗口标签来（Box 窗口、框选覆盖层等
//! 由宿主自己管理层级），而标签只有服务层知道。因此这里只接受一份**排除句柄清单**，
//! 不做任何业务判断——模块的职责边界就是「操作前台窗口的层级」这一件事。
//!
//! # 为什么排除桌面 / 任务栏壳窗口
//!
//! `Progman` / `WorkerW` / `Shell_TrayWnd` 也是「前台窗口」的合法取值（用户点了桌面或
//! 任务栏），但对它们置顶没有任何可见效果。此时返回 [`ForegroundPinOutcome::NoTarget`]
//! 让调用方明确知道「这次按键没有目标」，比静默地做一次无效操作更容易排查。
//!
//! # 为什么要重读样式而不是信任返回值
//!
//! `SetWindowPos` 返回 `Ok` 只说明调用没被系统拒绝，不代表样式位真的按预期翻转了
//! （窗口所属进程异常、被其它层级管理逻辑回滚都可能让结果与请求不符）。以
//! `GWL_EXSTYLE & WS_EX_TOPMOST` 的**实际读数值**作为唯一判据，切换结果才不会出现
//! 「日志说已置顶、用户看到的却还是原样」这种对不上的情况。

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::HWND;
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetForegroundWindow, GetWindowLongPtrW, GetWindowThreadProcessId, IsWindow,
    IsWindowVisible, SetWindowPos, GWL_EXSTYLE, HWND_NOTOPMOST, HWND_TOPMOST, SET_WINDOW_POS_FLAGS,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE, WS_EX_TOPMOST,
};

/// 置顶切换的结果，供服务层决定写哪条日志。
///
/// 不返回布尔值而是三态：`NoTarget`（当前没有可处理的前台窗口）与 `Unpinned`
/// （本次确实取消了置顶）都让「按键没反应」，但对排查来说是完全不同的两件事。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ForegroundPinOutcome {
    /// 目标窗口此前不在置顶层，本次已置顶。
    Pinned,
    /// 目标窗口此前已在置顶层，本次已取消置顶。
    Unpinned,
    /// 没有可处理的目标：取不到前台句柄、句柄已失效 / 不可见、命中桌面或任务栏壳窗口，
    /// 或命中本进程中由宿主自行管理层级的窗口（见排除清单）。
    NoTarget,
}

/// 只改 Z 序的窗口位置标志：不动位置 / 尺寸，也不改变激活状态。
///
/// `SWP_NOACTIVATE` **必需**：不置顶的窗口按快捷键时焦点仍在它身上，若不加这个标志，
/// `SetWindowPos` 会按默认语义把目标窗口激活到前台——在用户没有切换焦点的意图下抢走
/// 前台会让输入焦点乱跳（正在输入的内容跑掉）。`SWP_NOOWNERZORDER` 则避免连带调整
/// owner 窗口的层级。
#[cfg(target_os = "windows")]
const ZORDER_ONLY: SET_WINDOW_POS_FLAGS =
    SET_WINDOW_POS_FLAGS(SWP_NOMOVE.0 | SWP_NOSIZE.0 | SWP_NOACTIVATE.0 | SWP_NOOWNERZORDER.0);

/// 桌面宿主与任务栏的窗口类名；命中它们说明用户点的是桌面或任务栏，没有可置顶的对象。
#[cfg(target_os = "windows")]
const SHELL_WINDOW_CLASSES: [&str; 3] = ["Progman", "WorkerW", "Shell_TrayWnd"];

/// 读取窗口当前是否处于置顶层（`WS_EX_TOPMOST`）。
#[cfg(target_os = "windows")]
fn is_topmost(hwnd: HWND) -> bool {
    // SAFETY: 只读取窗口样式，不涉及任何所有权转移。
    (unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } & WS_EX_TOPMOST.0 as isize) != 0
}

/// 切换当前前台窗口的置顶状态。
///
/// `excluded_windows` 是调用方给出的、**本进程内不该被置顶的窗口句柄**（以 `HWND` 值表示）。
/// 服务层按窗口标签判定后传入，本模块只做句柄比对，不解释它们的业务含义。
///
/// 必须在窗口归属线程（主线程）调用。
#[cfg(target_os = "windows")]
pub(crate) fn toggle_foreground_topmost(
    excluded_windows: &[isize],
) -> Result<ForegroundPinOutcome, String> {
    use windows::Win32::System::Threading::GetCurrentProcessId;

    // SAFETY: 以下全部为只读查询或对前台句柄的 Z 序调整，句柄有效性已逐项校验。
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return Ok(ForegroundPinOutcome::NoTarget);
    }

    if !unsafe { IsWindow(Some(hwnd)) }.as_bool() || !unsafe { IsWindowVisible(hwnd) }.as_bool() {
        return Ok(ForegroundPinOutcome::NoTarget);
    }

    // 桌面 / 任务栏壳窗口：置顶它们没有可见效果，按「没有目标」处理。
    let mut class_buffer = [0u16; 256];
    let class_length = unsafe { GetClassNameW(hwnd, &mut class_buffer) };
    if class_length > 0 {
        let class_name = String::from_utf16_lossy(&class_buffer[..class_length as usize]);
        if SHELL_WINDOW_CLASSES.contains(&class_name.as_str()) {
            return Ok(ForegroundPinOutcome::NoTarget);
        }
    }

    // 排除清单只会包含本进程的窗口，因此先确认前台窗口确实属于本进程再比对：非本进程的
    // 窗口一律放行（用户想让任何应用都能置顶，这是本功能的全部意义）。
    let mut process_id: u32 = 0;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));
    }
    let own_process_id = unsafe { GetCurrentProcessId() };
    if process_id == own_process_id && excluded_windows.contains(&(hwnd.0 as isize)) {
        return Ok(ForegroundPinOutcome::NoTarget);
    }

    let was_topmost = is_topmost(hwnd);
    let insert_after = if was_topmost {
        HWND_NOTOPMOST
    } else {
        HWND_TOPMOST
    };

    unsafe { SetWindowPos(hwnd, Some(insert_after), 0, 0, 0, 0, ZORDER_ONLY) }
        .map_err(|error| format!("调整前台窗口层级失败：{error}"))?;

    // 以重读的样式位为唯一判据：返回值只说明调用被受理，不代表样式真的翻转了。
    let is_topmost_now = is_topmost(hwnd);
    if is_topmost_now == was_topmost {
        return Err("前台窗口的置顶状态未发生改变".to_string());
    }

    Ok(if is_topmost_now {
        ForegroundPinOutcome::Pinned
    } else {
        ForegroundPinOutcome::Unpinned
    })
}

/// 非 Windows 平台没有当前产品目标里的窗口置顶语义，保持显式错误避免误判已支持。
#[cfg(not(target_os = "windows"))]
pub(crate) fn toggle_foreground_topmost(
    _excluded_windows: &[isize],
) -> Result<ForegroundPinOutcome, String> {
    Err("当前平台暂不支持窗口置顶".to_string())
}
