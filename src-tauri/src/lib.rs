mod commands;
pub mod domain;
mod infrastructure;
mod services;

use tauri::Manager;

/// 启动 Dasktop 的 Tauri 运行时，只注册当前版本真实使用的命令和插件
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebView2 的启动参数必须在任何 WebView 创建之前落地，而 Box 的「显示桌面黑闪」
    // 由此修复（关闭 Chromium 的原生窗口遮挡检测），故放在最前面。
    infrastructure::windows::webview_runtime::apply_browser_arguments();

    let Some(single_instance_guard) =
        infrastructure::windows::single_instance::acquire_or_notify_existing()
            .expect("failed to initialize dasktop single instance guard")
    else {
        return;
    };

    let app = tauri::Builder::default()
        // 自启注册项携带 `--autostart`：Windows 的 Run 键只记录命令行，
        // 无法在进程内反查「本次是否由自启拉起」，只能在注册时把意图写进命令。
        // 这样 setup 中就能区分「开机静默驻留托盘」与「用户主动双击」。
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![services::app::lifecycle::AUTOSTART_LAUNCH_ARGUMENT]),
        ))
        .plugin(tauri_plugin_sql::Builder::default().build())
        // 全局快捷键插件：插件启动热键的「挂到系统」由注册层消费本插件完成，
        // 宿主只在 Rust 侧注册，不暴露任何前端命令，因此无需 capability 授权。
        .plugin(tauri_plugin_global_shortcut::Builder::default().build())
        // 屏幕框选会话：同一时刻只允许一个框选层，等待端登记在这里，由覆盖窗口回填结果。
        .manage(services::plugin::ScreenCaptureSession::default())
        // 插件页面资源走自定义协议：插件界面是作者自己写的网页，宿主把插件包目录
        // 映射成 `plugin` 协议供插件窗口加载。URL 前缀由 `services::plugin::asset_base_url`
        // 按平台给出（Windows 上是 `http://plugin.localhost`）。
        .register_uri_scheme_protocol(domain::plugin::PLUGIN_PROTOCOL_SCHEME, |ctx, request| {
            services::plugin::handle_plugin_asset_request(ctx.app_handle(), &request)
        })
        .setup(move |app| {
            app.manage(single_instance_guard);
            infrastructure::windows::single_instance::start_show_settings_listener(
                app.handle().clone(),
            )
            .map_err(std::io::Error::other)?;
            infrastructure::tauri::tray::setup_app_tray(app)?;

            // 冷启动路径：本次进程就是主实例（没有可转交的既有实例）。
            //
            // 设置窗口在 tauri.conf.json 中配置为 visible:false，是否显示取决于
            // 本次启动意图，共三类：
            // - 工作区快捷方式（`--workspace <id>`）：显示窗口，用户要看到还原进度；
            // - 开机自启（`--autostart`）：静默驻留托盘，不打扰用户；
            // - 其余（用户双击 exe / 开始菜单 / 任务栏）：显示窗口。
            //
            // 第三类是修复前的 bug：窗口全程隐藏，用户双击后看不到界面，
            // 只能去托盘找，观感上就像「点了没反应」。
            let is_silent_autostart = services::app::lifecycle::is_autostart_launch();
            if !is_silent_autostart {
                infrastructure::tauri::tray::show_settings_window(app.handle());
            }

            // 启动即注册全部有效启动热键：用户可能从不打开设置页，但热键应从开机就生效。
            // 此时前端尚未连库，配置表读不到，注册的是「未配置」状态（没有热键）；用户后续的
            // 配置会经 set_plugin_hotkey 命令再次触发全量重注册。
            let hotkey_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = services::plugin::register_all_plugin_hotkeys(&hotkey_app).await
                {
                    eprintln!("[plugin] 启动注册插件热键失败：{error}");
                }
            });

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
            commands::box_window::glue_box_window_to_desktop,
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
            commands::plugin::cancel_plugin_screen_capture,
            commands::plugin::capture_plugin_screen_region,
            commands::plugin::finish_plugin_screen_capture,
            commands::plugin::list_plugins,
            commands::plugin::notify_from_plugin,
            commands::plugin::open_plugin_root,
            commands::plugin::open_plugin_window,
            commands::plugin::plugin_http_request,
            commands::plugin::list_plugin_hotkeys,
            commands::plugin::set_plugin_hotkey,
            commands::plugin::sync_dev_plugin_packages,
            commands::plugin::read_plugin_clipboard_image,
            commands::plugin::read_plugin_clipboard_text,
            commands::plugin::read_plugin_package_file,
            commands::plugin::save_plugin_file,
            commands::plugin::write_plugin_clipboard_text,
            commands::plugin::write_plugin_log,
            commands::plugin::write_plugin_package_file,
            commands::app::is_autostart_enabled,
            commands::app::is_autostart_launch,
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
