//! 插件命令层。
//!
//! 只做 IPC 参数接收与转发，命令本身不做权限判断。
//!
//! 需要留意：下面这几条能力命令（`read_plugin_package_file` / `write_plugin_package_file` /
//! `write_plugin_log` / `notify_from_plugin` / `plugin_http_request`）当前**没有前端调用方**。
//! 插件界面是插件窗口里的普通网页，而插件窗口刻意不在 capabilities 白名单内，因此它
//! 无法 invoke 任何命令。保留这些能力是为了下一步的受控桥能直接复用——宿主会把一份
//! 经权限校验的能力对象注入插件页面，权限判定的落点届时仍在宿主这一侧。

use tauri::AppHandle;

use crate::domain::plugin::{PluginHttpRequest, PluginHttpResponse, PluginScanResult};
use crate::services::plugin;

/// 扫描插件根目录，返回全部插件包的清单与解析失败原因。
///
/// 首次调用会创建插件根目录并在其为空时写入内置示例包。
#[tauri::command]
pub fn list_plugins(app: AppHandle) -> Result<PluginScanResult, String> {
    plugin::scan_plugin_packages(&app)
}

/// 返回插件页面资源的 URL 前缀（形如 `http://plugin.localhost`）。
///
/// 平台差异必须由后端判断：WebView 在 Windows 上把自定义协议映射成
/// `http://<scheme>.localhost`，其它平台才是 `<scheme>://localhost`。前端拿到前缀后
/// 再拼 `/<插件id>/<相对路径>`。
#[tauri::command]
pub fn plugin_asset_base_url() -> String {
    plugin::asset_base_url()
}

/// 读取插件包内文本文件，对应 `fs:read` 能力。
#[tauri::command]
pub fn read_plugin_package_file(
    app: AppHandle,
    plugin_id: String,
    relative_path: String,
) -> Result<String, String> {
    plugin::read_plugin_file(&app, &plugin_id, &relative_path)
}

/// 写入插件包内文本文件，对应 `fs:write` 能力。
#[tauri::command]
pub fn write_plugin_package_file(
    app: AppHandle,
    plugin_id: String,
    relative_path: String,
    contents: String,
) -> Result<(), String> {
    plugin::write_plugin_file(&app, &plugin_id, &relative_path, &contents)
}

/// 追加插件运行日志，对应 `log:write` 能力。
#[tauri::command]
pub fn write_plugin_log(
    app: AppHandle,
    plugin_id: String,
    level: String,
    message: String,
) -> Result<(), String> {
    plugin::write_plugin_log(&app, &plugin_id, &level, &message)
}

/// 发送宿主通知，对应 `ui:notify` 能力。
#[tauri::command]
pub fn notify_from_plugin(
    app: AppHandle,
    plugin_id: String,
    title: String,
    message: String,
) -> Result<(), String> {
    plugin::notify_from_plugin(&app, &plugin_id, &title, &message)
}

/// 代表插件发起 HTTP 请求，对应 `net:request` 能力。
///
/// 刻意声明为异步：请求耗时完全取决于远端，同步命令会让整条 IPC 通道一起等待。
#[tauri::command]
pub async fn plugin_http_request(
    app: AppHandle,
    plugin_id: String,
    request: PluginHttpRequest,
) -> Result<PluginHttpResponse, String> {
    plugin::http_request(&app, &plugin_id, request).await
}

/// 用系统资源管理器打开插件根目录，供用户手工安装插件包。
#[tauri::command]
pub fn open_plugin_root(app: AppHandle) -> Result<(), String> {
    plugin::open_plugin_root(&app)
}
