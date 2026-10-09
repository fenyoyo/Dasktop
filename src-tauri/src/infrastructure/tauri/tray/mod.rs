//! 系统托盘入口负责应用级命令分发，不直接读写 Box 数据。

mod autostart;
mod menu;
mod state;
mod window;

use tauri::tray::TrayIconBuilder;
use tauri::{App, Manager};

pub use autostart::{resolve_autostart_enabled, set_autostart_enabled};
pub(crate) use window::{handle_window_close_requested, show_settings_window};

/// 初始化系统托盘图标和右键菜单；菜单只分发动作，具体 Box 生命周期仍由前端统一处理。
pub fn setup_app_tray(app: &App) -> tauri::Result<()> {
    // 升级后自启注册项可能还是旧命令（缺 `--autostart`），这里顺手重写一次，
    // 让「开机静默」在新版本下立即生效，不需要用户手动关开一次开关。
    autostart::refresh_autostart_entry(app.handle());

    let autostart_enabled = autostart::resolve_initial_autostart_enabled(app.handle());
    let (tray_menu, autostart_item) = menu::build_tray_menu(app, autostart_enabled)?;
    let autostart_item_for_menu = autostart_item.clone();
    let mut tray_builder = TrayIconBuilder::with_id(menu::TRAY_ID)
        .tooltip("Dasktop")
        .menu(&tray_menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app_handle, event| {
            menu::handle_tray_menu_event(app_handle, &event, &autostart_item_for_menu);
        })
        .on_tray_icon_event(|tray, event| {
            if menu::is_left_click_release(&event) {
                window::show_settings_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        tray_builder = tray_builder.icon(icon.clone());
    }

    tray_builder.build(app)?;
    app.manage(state::AppTrayState::new(autostart_item));
    Ok(())
}
