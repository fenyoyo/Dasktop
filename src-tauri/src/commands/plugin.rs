//! 插件命令层。
//!
//! 只做 IPC 参数接收与转发，命令本身不做权限判断：权限门控由前端受控上下文负责，
//! 这样新增能力时后端只需暴露命令、前端只需加一条权限映射，两边不会各维护一套判断。

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

/// 读取指定插件的入口源码。
///
/// 前端拿到源码后用 Blob URL 包装成 ESM 模块再动态导入，因此这里返回的是原始文本，
/// 而不是可执行对象——宿主不替插件做任何代码转换。
#[tauri::command]
pub fn read_plugin_entry(app: AppHandle, plugin_id: String) -> Result<String, String> {
    plugin::read_plugin_entry(&app, &plugin_id)
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
