//! 应用生命周期服务负责把命令层的请求转交给 Tauri 外设，并隐藏托盘同步细节。

use super::shell_icon_restore;
use crate::infrastructure::tauri::tray;
use crate::infrastructure::windows::mouse;
use tauri::AppHandle;

/// 开机自启注册项携带的启动参数。
///
/// Windows 的 Run 键只保存一段命令行，进程启动后无法反查「是否由自启拉起」。
/// 因此把标记写进注册的自启命令里，启动时检查 `argv` 即可区分：
/// 带该参数说明是系统按自启策略拉起，应静默驻留托盘。
pub const AUTOSTART_LAUNCH_ARGUMENT: &str = "--autostart";

/// 判断本次进程是否由开机自启拉起。
///
/// 只检查参数是否存在，不关心出现位置，避免注册表命令行被用户或安全软件
/// 调整参数顺序后失效。
pub fn is_autostart_launch() -> bool {
    std::env::args().any(|argument| argument == AUTOSTART_LAUNCH_ARGUMENT)
}

/// 读取插件中的系统自启状态，供设置页命令使用。
pub fn resolve_autostart_enabled(app: &AppHandle) -> Result<bool, String> {
    tray::resolve_autostart_enabled(app)
}

/// 写入系统自启状态并同步所有 UI 入口，避免设置页和托盘出现互相矛盾的勾选状态。
pub fn set_autostart_enabled(app: &AppHandle, enabled: bool) -> Result<bool, String> {
    tray::set_autostart_enabled(app, enabled)
}

/// 读取系统级左键状态，供跨 WebView 拖拽兜底判断释放时机。
pub fn is_primary_mouse_button_pressed() -> bool {
    mouse::is_primary_mouse_button_pressed()
}

/// 应用正常退出前释放 Dasktop 对系统桌面图标的接管，让 Windows 桌面回到接管前状态。
pub fn restore_shell_desktop_icons_before_exit(app: &AppHandle) -> Result<(), String> {
    shell_icon_restore::restore_shell_desktop_icons_before_exit(app)
}
