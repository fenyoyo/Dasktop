use crate::services::app::{hotkey, lifecycle};
use tauri::AppHandle;

/// 读取系统开机自启状态；状态来源是官方 autostart 插件，不写入前端 SQLite 设置表。
#[tauri::command]
pub fn is_autostart_enabled(app: AppHandle) -> Result<bool, String> {
    lifecycle::resolve_autostart_enabled(&app)
}

/// 判断本次进程是否由开机自启拉起。
///
/// 与 `is_autostart_enabled` 的语义不同：后者读系统里「自启是否已启用」这一持久设置，
/// 前者只回答「这一次启动是不是自启触发的」。设置页据此决定 Box 恢复完成后是否收起窗口。
#[tauri::command]
pub fn is_autostart_launch() -> bool {
    lifecycle::is_autostart_launch()
}

/// 切换系统开机自启状态，并同步托盘菜单与设置页开关。
#[tauri::command]
pub fn set_autostart_enabled(app: AppHandle, enabled: bool) -> Result<bool, String> {
    lifecycle::set_autostart_enabled(&app, enabled)
}

/// 读取系统级左键状态，跨 WebView 拖拽释放时不依赖当前窗口能否收到鼠标事件。
#[tauri::command]
pub fn is_primary_mouse_button_pressed() -> bool {
    lifecycle::is_primary_mouse_button_pressed()
}

/// 读取「置顶当前前台窗口」全局快捷键的配置与可用状态。
///
/// 声明为 `async` 是因为要读 SQLite：配置存在 `app_settings`，读库是异步的。
#[tauri::command]
pub async fn list_foreground_pin_hotkey(
    app: AppHandle,
) -> Result<hotkey::ForegroundPinHotkeyRegistration, String> {
    hotkey::list_foreground_pin_hotkey(&app).await
}

/// 写入「置顶当前前台窗口」全局快捷键配置，并立即把全部全局快捷键重挂到系统。
///
/// 返回写入后的状态而不是 `()`：面板据此立即刷新「能不能注册上」的判定，不必再发一次查询。
#[tauri::command]
pub async fn set_foreground_pin_hotkey(
    app: AppHandle,
    accelerator: String,
    enabled: bool,
) -> Result<hotkey::ForegroundPinHotkeyRegistration, String> {
    hotkey::set_foreground_pin_hotkey(&app, &accelerator, enabled).await
}
