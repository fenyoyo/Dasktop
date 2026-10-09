//! 托盘相关窗口显示、隐藏和退出流程。

use crate::domain::app::contract::SETTINGS_WINDOW_LABEL;
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
    }
}
