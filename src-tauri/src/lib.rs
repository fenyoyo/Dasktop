mod commands;
pub mod domain;
mod infrastructure;
mod services;

use tauri::Manager;

/// 启动 Dasktop 的 Tauri 运行时，只注册当前版本真实使用的命令和插件
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let Some(single_instance_guard) =
        infrastructure::windows::single_instance::acquire_or_notify_existing()
            .expect("failed to initialize dasktop single instance guard")
    else {
        return;
    };

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_sql::Builder::default().build())
        .setup(move |app| {
            app.manage(single_instance_guard);
            infrastructure::windows::single_instance::start_show_settings_listener(
                app.handle().clone(),
            )
            .map_err(std::io::Error::other)?;
            infrastructure::tauri::tray::setup_app_tray(app)?;

            // 冷启动路径：本次进程就是主实例（没有可转交的既有实例）。
            //
            // 设置窗口在 tauri.conf.json 中配置为 visible:false，普通启动
            // （例如开机自启）应静默驻留托盘；但由工作区快捷方式启动时，
            // 用户期待立刻看到还原进度，且工作区还原逻辑挂在前端面板的
            // onMounted 上——窗口不显示，组件就不会挂载，快捷方式看起来
            // 就像「点了没反应」。因此仅在携带工作区参数时主动显示窗口。
            if services::workspace::resolve_startup_workspace_id().is_some() {
                infrastructure::tauri::tray::show_settings_window(app.handle());
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            infrastructure::tauri::tray::handle_window_close_requested(window, event);
        })
        .invoke_handler(tauri::generate_handler![
            commands::box_folder::choose_collection_root_folder,
            commands::box_folder::create_box_folder,
            commands::box_folder::delete_box_folder,
            commands::box_folder::handle_box_dragged_paths_to_desktop,
            commands::box_folder::handle_box_dropped_paths,
            commands::box_folder::migrate_box_folder,
            commands::box_folder::open_box_folder,
            commands::desktop::delete_desktop_items,
            commands::desktop::get_box_folder_revision,
            commands::desktop::get_desktop_snapshot,
            commands::desktop::get_shell_desktop_icon_visible,
            commands::desktop::list_box_folder_items,
            commands::desktop::list_shell_desktop_items,
            commands::desktop::open_desktop_item,
            commands::desktop::paste_desktop_items_from_clipboard,
            commands::desktop::rename_desktop_item,
            commands::desktop::set_shell_desktop_icon_visible,
            commands::desktop::show_native_item_context_menu,
            commands::desktop::write_desktop_items_to_clipboard,
            commands::native_drop::register_box_native_drop_target,
            commands::native_drop::unregister_box_native_drop_target,
            commands::app::is_autostart_enabled,
            commands::app::is_primary_mouse_button_pressed,
            commands::app::set_autostart_enabled,
            commands::workspace::capture_workspace_layout,
            commands::workspace::create_workspace_desktop_shortcut,
            commands::workspace::resolve_current_executable_path,
            commands::workspace::resolve_executable_icons,
            commands::workspace::resolve_startup_workspace_id,
            commands::workspace::restore_workspace_layout,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build dasktop");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            if let Err(error) =
                services::app::lifecycle::restore_shell_desktop_icons_before_exit(app_handle)
            {
                eprintln!("failed to restore shell desktop icons before exit: {error}");
            }
        }
    });
}
