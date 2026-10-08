//! Box 窗口的「桌面置顶固定」用例。
//!
//! Win+D「显示桌面」会隐藏普通 Z 序窗口，违背「Box 常驻桌面」的产品语义。
//! 正确的做法是把 Box 固定为「置顶 + 免疫 Win+D」（Pin Mode），详见
//! `desktop_glue`。Box 保持普通顶层窗口，WebView2 输入链不受影响。
//!
//! 这里把固定决策放在服务层：校验 label 确实是 Box 窗口后，先在工作线程
//! 解析窗口句柄并做短重试，再把底层固定调度回主线程（窗口归属线程）执行。
//!
//! 为什么句柄解析不在主线程做：实测在 `tauri://created` 后立即从主线程
//! 内联调用 `hwnd()` 会命中 dispatcher 的重入窗口期，返回
//! 「the underlying handle is not available」；工作线程调用走事件队列
//! 异步应答，天然避开该问题，重试则兜底注册时序的抖动。
//! 底层固定失败只记录日志并保持原有顶层窗口行为，不向用户抛错中断打开流程。

use std::time::Duration;

use tauri::{AppHandle, Manager};
use windows::Win32::Foundation::HWND;

use crate::domain::app::contract::is_box_window_label;
use crate::infrastructure::windows::desktop_glue;

/// `tauri://created` 之后运行时窗口表仍可能存在短暂就绪窗口期，
/// 重试上限按「次数 × 间隔 ≈ 2s」设计，覆盖慢机器上的启动抖动。
const HANDLE_RESOLVE_RETRY_LIMIT: usize = 20;

/// 句柄解析重试间隔；过短会空转，过长拖慢吸附生效时间。
const HANDLE_RESOLVE_RETRY_INTERVAL: Duration = Duration::from_millis(100);

/// 把指定 Box 窗口固定为「置顶 + 免疫 Win+D」，使其在显示桌面时保持可见。
///
/// 固定在后台异步推进，本函数只负责校验和调度，立即返回。
pub fn glue_box_window_to_desktop(app: &AppHandle, window_label: &str) -> Result<(), String> {
    if !is_box_window_label(window_label) {
        return Err("只有 Box 窗口允许桌面置顶固定".to_string());
    }

    let app_handle = app.clone();
    let label = window_label.to_string();
    std::thread::Builder::new()
        .name("box-desktop-glue".into())
        .spawn(move || glue_on_worker_thread(app_handle, label))
        .map_err(|error| format!("无法调度 Box 桌面固定: {error}"))?;
    Ok(())
}

/// 工作线程入口：解析句柄后把桌面固定调度回主线程。
fn glue_on_worker_thread(app: AppHandle, label: String) {
    // HWND 内部是裸指针不满足 Send，跨线程只传 isize，主线程侧再还原。
    let Some(hwnd) = resolve_window_handle(&app, &label).map(|hwnd| hwnd.0 as isize) else {
        eprintln!("failed to resolve box window {label} handle after retries, skip desktop glue");
        return;
    };

    // 置顶 + 子类化必须在窗口归属线程（主线程）执行；工作线程只负责解析句柄。
    if let Err(error) = app.run_on_main_thread(move || {
        if let Err(error) = desktop_glue::glue_box_window_to_desktop(HWND(hwnd as *mut _)) {
            eprintln!("failed to glue box window to desktop host: {error}");
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
                    eprintln!(
                        "resolve box window {label} handle attempt {attempt} failed: {error}"
                    );
                }
            }
        }
        std::thread::sleep(HANDLE_RESOLVE_RETRY_INTERVAL);
    }

    None
}
