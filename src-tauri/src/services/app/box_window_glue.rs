//! Box 窗口的「桌面层」（On Desktop）用例。
//!
//! 目标语义有两条互相拉扯的约束：**不遮挡任何窗口** 且 **显示桌面时保持可见**。
//! 实现方式是把 Box 落到桌面层（普通状态下位于 `HWND_BOTTOM`），并轮询
//! 「显示桌面」状态在必要时把它搬进置顶带——完整机理见 `desktop_glue` 模块文档。
//!
//! 本模块负责三件编排工作：
//!
//! 1. **固定单个 Box**：校验 label 确实是 Box 窗口后，在工作线程解析窗口句柄并做短
//!    重试，再把底层固定调度回主线程（窗口归属线程）执行。
//! 2. **启动全局状态监视**：桌面状态的翻转是全局事件、与具体 Box 无关，因此每进程
//!    只启动一条轮询线程；它只负责把「重新排层」这个动作投递到主线程执行。
//! 3. **降级**：底层固定失败只记录日志并保留 Tauri 默认的顶层窗口行为，不向用户抛错
//!    中断打开流程。
//!
//! 为什么句柄解析不在主线程做：实测在 `tauri://created` 后立即从主线程内联调用
//! `hwnd()` 会命中 dispatcher 的重入窗口期，返回「the underlying handle is not
//! available」；工作线程调用走事件队列异步应答，天然避开该问题，重试则兜底注册时序抖动。

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use windows::Win32::Foundation::HWND;

use crate::domain::app::contract::is_box_window_label;
use crate::infrastructure::windows::desktop_glue;

/// `tauri://created` 之后运行时窗口表仍可能存在短暂就绪窗口期，
/// 重试上限按「次数 × 间隔 ≈ 2s」设计，覆盖慢机器上的启动抖动。
const HANDLE_RESOLVE_RETRY_LIMIT: usize = 20;

/// 句柄解析重试间隔；过短会空转，过长拖慢吸附生效时间。
const HANDLE_RESOLVE_RETRY_INTERVAL: Duration = Duration::from_millis(100);

/// 桌面状态轮询间隔。
///
/// 帧率级（≈60Hz）而非原来的 150ms：Win+D 是 **Explorer 自己先把桌面宿主提升到最前**，
/// Box 由我们事后跟上去。轮询越慢，「桌面已浮起、Box 还被盖在最底层」的中间态就越长，
/// 随后 Box 才补位出现——两次 Z 序变更叠加，观感上正是「快速黑闪一下」。
/// 把跟随延迟压到一帧以内，可让 Box 的补位与桌面提升落在同一批合成里。
///
/// 探测是短路遍历（普通状态下通常 1~2 步就撞到可见非置顶窗口返回），且真正的状态
/// 判定在轮询线程完成，只有翻转时才投递主线程，因此 16ms 的频率开销可忽略。
const DESKTOP_STATE_POLL_INTERVAL: Duration = Duration::from_millis(16);

/// 兜底重同步周期。
///
/// 覆盖「桌面状态没翻转、但 Box 的层级被 Explorer 或其它应用扰动」的情况：
/// 每隔这个周期无条件重新对齐一次，日常轮询则保持零打扰。
const DESKTOP_STATE_RESYNC_INTERVAL: Duration = Duration::from_secs(1);

/// 桌面状态监视线程是否已启动（每进程只启动一次）。
static MONITOR_STARTED: AtomicBool = AtomicBool::new(false);

/// 把指定 Box 窗口落到「桌面层」，使其不遮挡其它窗口且在显示桌面时保持可见。
///
/// 固定与监视均在后台异步推进，本函数只负责校验和调度，立即返回。
pub fn glue_box_window_to_desktop(app: &AppHandle, window_label: &str) -> Result<(), String> {
    if !is_box_window_label(window_label) {
        return Err("只有 Box 窗口允许固定到桌面层".to_string());
    }

    // 桌面状态翻转是全局事件，与具体 Box 无关，因此在这里顺带保证监视线程已启动。
    start_desktop_state_monitor(app);

    let app_handle = app.clone();
    let label = window_label.to_string();
    std::thread::Builder::new()
        .name("box-desktop-glue".into())
        .spawn(move || glue_on_worker_thread(app_handle, label))
        .map_err(|error| format!("无法调度 Box 桌面层固定: {error}"))?;
    Ok(())
}

/// 启动桌面状态轮询线程；已启动过则直接返回。
///
/// 线程自身不碰任何 Win32 窗口操作，只把「重新排层」投递到主线程——`SetWindowPos`
/// 与子类化过程都必须在窗口归属线程上执行。
fn start_desktop_state_monitor(app: &AppHandle) {
    if MONITOR_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    let app_handle = app.clone();
    let spawned = std::thread::Builder::new()
        .name("box-desktop-monitor".into())
        .spawn(move || {
            let mut last_resync = Instant::now();
            loop {
                std::thread::sleep(DESKTOP_STATE_POLL_INTERVAL);

                // 没有存活的 Box 就不必打扰主线程；Box 全部关闭后线程继续空转待命。
                if !desktop_glue::has_pinned_boxes() {
                    continue;
                }

                // 只读探测留在轮询线程：只有状态翻转（或到达兜底周期）才投递主线程，
                // 主线程事件队列不会被帧率级的轮询淹没。
                let desktop_shown = desktop_glue::probe_desktop_shown();
                let now = Instant::now();
                let need_resync = now.duration_since(last_resync) >= DESKTOP_STATE_RESYNC_INTERVAL;
                if desktop_shown == desktop_glue::current_band_state() && !need_resync {
                    continue;
                }
                last_resync = now;

                if let Err(error) = app_handle.run_on_main_thread(move || {
                    desktop_glue::apply_desktop_band(desktop_shown);
                }) {
                    // 应用正在退出：主线程事件循环已不可用，线程自行结束。
                    eprintln!("box desktop monitor stopped: {error}");
                    return;
                }
            }
        });

    if let Err(error) = spawned {
        MONITOR_STARTED.store(false, Ordering::SeqCst);
        eprintln!("failed to spawn box desktop monitor: {error}");
    }
}

/// 工作线程入口：解析句柄后把桌面层固定调度回主线程。
fn glue_on_worker_thread(app: AppHandle, label: String) {
    // HWND 内部是裸指针不满足 Send，跨线程只传 isize，主线程侧再还原。
    let Some(hwnd) = resolve_window_handle(&app, &label).map(|hwnd| hwnd.0 as isize) else {
        eprintln!("failed to resolve box window {label} handle after retries, skip desktop glue");
        return;
    };

    // 排层 + 子类化必须在窗口归属线程（主线程）执行；工作线程只负责解析句柄。
    if let Err(error) = app.run_on_main_thread(move || {
        if let Err(error) = desktop_glue::glue_box_window_to_desktop(HWND(hwnd as *mut _)) {
            eprintln!("failed to glue box window to desktop layer: {error}");
        }
    }) {
        eprintln!("failed to dispatch desktop glue for {label}: {error}");
    }
}

/// 在工作线程轮询解析 Box 窗口句柄；窗口已销毁时按重试上限放弃。
fn resolve_window_handle(app: &AppHandle, label: &str) -> Option<HWND> {
    for attempt in 0..HANDLE_RESOLVE_RETRY_LIMIT {
        if let Some(webview_window) = app.get_webview_window(label) {
            match webview_window.hwnd() {
                Ok(hwnd) => return Some(hwnd),
                Err(error) => {
                    eprintln!("resolve box window {label} handle attempt {attempt} failed: {error}");
                }
            }
        }
        std::thread::sleep(HANDLE_RESOLVE_RETRY_INTERVAL);
    }

    None
}
