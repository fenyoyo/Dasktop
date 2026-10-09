//! 托盘相关窗口显示、隐藏和退出流程。

use crate::domain::app::contract::SETTINGS_WINDOW_LABEL;
use crate::infrastructure::windows::desktop_glue;
use tauri::{AppHandle, Manager, Window, WindowEvent, Wry};

use super::state::AppTrayState;

/// 托盘“关闭”是真正退出应用，需要让所有 WebViewWindow 先走销毁链路。
///
/// Windows WebView2/Chromium 在进程退出时会注销内部窗口类。逐个销毁窗口并用退出标记
/// 跳过设置窗隐藏拦截，可以让底层清理和窗口销毁顺序更稳定。
pub(crate) fn request_graceful_exit(app_handle: &AppHandle) {
    if let Some(tray_state) = app_handle.try_state::<AppTrayState>() {
        tray_state.request_graceful_exit();
    }

    let webview_windows = app_handle.webview_windows();
    if webview_windows.is_empty() {
        app_handle.exit(0);
        return;
    }

    for (label, webview_window) in webview_windows {
        if let Err(error) = webview_window.destroy() {
            eprintln!("failed to destroy webview window {label} before exit: {error}");
        }
    }
}

/// 任务栏或系统菜单关闭设置窗时只隐藏主窗口，保留隐藏控制器和 Store 事件入口供托盘再次唤起。
pub(crate) fn handle_window_close_requested(window: &Window<Wry>, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    if window.label() != SETTINGS_WINDOW_LABEL {
        return;
    }
    let Some(tray_state) = window.app_handle().try_state::<AppTrayState>() else {
        return;
    };
    if tray_state.is_graceful_exit_requested() {
        return;
    }

    api.prevent_close();
    if let Err(error) = window.hide() {
        eprintln!("failed to hide settings window after close request: {error}");
    }
    // 设置窗隐藏后退出置顶层，让 Box 重新回到最上层（仍保持 Win+D 免疫）。
    desktop_glue::restore_boxes_on_top();
}

/// 设置窗口焦点变化时同步它和 Box 的相对层级。
///
/// 聚焦：把设置窗提升到置顶层并压在 Box 之上，保证用户操作时不被 Box 遮挡。
/// 失焦：把设置窗降回普通层、Box 回到最上层，避免设置窗长期占据置顶层挡住
/// 其它应用（用户切到浏览器后设置窗仍浮在上面会很干扰）。
pub(crate) fn handle_settings_focus_change(window: &Window<Wry>, event: &WindowEvent) {
    let WindowEvent::Focused(focused) = event else {
        return;
    };
    if window.label() != SETTINGS_WINDOW_LABEL {
        return;
    }

    if *focused {
        match window.hwnd() {
            Ok(hwnd) => desktop_glue::raise_window_above_boxes(hwnd),
            Err(error) => eprintln!(
                "failed to resolve settings window handle for z-order raise: {error}"
            ),
        }
    } else {
        desktop_glue::restore_boxes_on_top();
    }
}

/// 打开并聚焦隐藏的设置窗口，供托盘左键、设置菜单和单实例唤起共同复用。
pub(crate) fn show_settings_window(app_handle: &AppHandle) {
    if let Some(settings_window) = app_handle.get_webview_window(SETTINGS_WINDOW_LABEL) {
        if let Err(error) = settings_window.unminimize() {
            eprintln!("failed to unminimize settings window: {error}");
        }
        if let Err(error) = settings_window.show() {
            eprintln!("failed to show settings window: {error}");
        }
        if let Err(error) = settings_window.set_focus() {
            eprintln!("failed to focus settings window: {error}");
        }
        // Box 常驻置顶层（免疫 Win+D），直接显示会被它盖住。这里让设置窗也进入
        // 置顶层并排在 Box 之前，两者都保留 Win+D 免疫且设置窗不再被遮挡。
        // 句柄解析失败时降级为不提升，仅表现为「Box 可能盖住设置窗」，不影响功能。
        match settings_window.hwnd() {
            Ok(hwnd) => desktop_glue::raise_window_above_boxes(hwnd),
            Err(error) => eprintln!("failed to resolve settings window handle for z-order raise: {error}"),
        }
    }
}
