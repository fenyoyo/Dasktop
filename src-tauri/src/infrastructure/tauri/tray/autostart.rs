//! 开机自启状态读写与 UI 同步。

use crate::domain::app::contract::{AUTOSTART_CHANGED_EVENT, SETTINGS_WINDOW_LABEL};
use tauri::menu::CheckMenuItem;
use tauri::Wry;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;

use super::state::AppTrayState;

/// 读取插件中的系统自启状态，供设置页和托盘初始化共享。
pub fn resolve_autostart_enabled(app: &AppHandle) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|error| format!("无法读取开机自启状态：{error}"))
}

/// 托盘初始化时读取自启状态；失败时只影响初始勾选展示，记录日志后使用关闭态兜底。
pub(super) fn resolve_initial_autostart_enabled(app: &AppHandle) -> bool {
    match resolve_autostart_enabled(app) {
        Ok(enabled) => enabled,
        Err(error) => {
            eprintln!("{error}");
            false
        }
    }
}

/// 让已存在的自启注册项补上当前的启动参数。
///
/// 自启命令是在「开启自启」那一刻写进系统启动项的，升级后的新参数不会自动生效。
/// 这里在启动时重写一次自启项：仅在自启已开启时执行，且重写内容与
/// `set_autostart_enabled` 完全一致（先 disable 再 enable），因此是幂等的。
///
/// 失败只记录日志：自启项文案陈旧会让下次开机走「显示窗口」分支，
/// 属于体验降级而非功能损坏，不应阻断启动流程。
pub(super) fn refresh_autostart_entry(app: &AppHandle) {
    if !matches!(resolve_autostart_enabled(app), Ok(true)) {
        return;
    }

    let autolaunch = app.autolaunch();
    if let Err(error) = autolaunch.disable() {
        eprintln!("failed to refresh autostart entry: {error}");
        return;
    }
    if let Err(error) = autolaunch.enable() {
        eprintln!("failed to refresh autostart entry: {error}");
    }
}

/// 写入系统自启状态并同步所有 UI 入口，避免设置页和托盘出现互相矛盾的勾选状态。
pub fn set_autostart_enabled(app: &AppHandle, enabled: bool) -> Result<bool, String> {
    let autolaunch = app.autolaunch();
    if enabled {
        autolaunch
            .enable()
            .map_err(|error| format!("无法开启开机自启：{error}"))?;
    } else {
        autolaunch
            .disable()
            .map_err(|error| format!("无法关闭开机自启：{error}"))?;
    }

    sync_autostart_state(app, enabled);
    Ok(enabled)
}

/// 托盘菜单切换自启时使用当前勾选状态作为目标值；读取或写入失败时回读系统状态修正 UI。
pub(super) fn toggle_autostart_from_tray(app: &AppHandle, autostart_item: &CheckMenuItem<Wry>) {
    let next_enabled = match autostart_item.is_checked() {
        Ok(enabled) => enabled,
        Err(error) => {
            eprintln!("failed to read tray autostart check state: {error}");
            resync_autostart_from_system(app);
            return;
        }
    };

    if let Err(error) = set_autostart_enabled(app, next_enabled) {
        eprintln!("{error}");
        resync_autostart_from_system(app);
    }
}

fn resync_autostart_from_system(app: &AppHandle) {
    if let Ok(current_enabled) = resolve_autostart_enabled(app) {
        sync_autostart_state(app, current_enabled);
    }
}

/// 同步托盘勾选状态和设置页开关状态，保证多个入口看到的系统状态一致。
pub(super) fn sync_autostart_state(app: &AppHandle, enabled: bool) {
    if let Some(tray_state) = app.try_state::<AppTrayState>() {
        if let Err(error) = tray_state.autostart_item.set_checked(enabled) {
            eprintln!("failed to sync tray autostart check state: {error}");
        }
    }
    if let Err(error) = app.emit_to(SETTINGS_WINDOW_LABEL, AUTOSTART_CHANGED_EVENT, enabled) {
        eprintln!("failed to emit autostart state change: {error}");
    }
}
