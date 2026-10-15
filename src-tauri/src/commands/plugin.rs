//! 插件命令层。
//!
//! 只做 IPC 参数接收与转发。
//!
//! 五条能力命令都带一个 `window: tauri::Window` 参数，这不是为了操作窗口，而是为了拿到
//! **调用方身份**：插件窗口的标签是 `plugin_<id>`，由宿主建窗时写死，插件页面改不了。
//! 命令参数里的 `plugin_id` 则完全由插件填写，只作为宿主窗口调用时的兜底。两者交给
//! [`plugin::resolve_caller_plugin_id`] 收敛，结果是「插件只能以自己的身份调能力」。
//!
//! 权限判定不在这里，而在服务层：ACL 的粒度是窗口、清单的粒度是插件，命令层拿不到
//! 「这个插件声明了什么」这个信息，只能读清单，那属于服务层的编排职责。

use tauri::{AppHandle, Window};

use crate::domain::plugin::{PluginHttpRequest, PluginHttpResponse, PluginScanResult};
use crate::services::plugin;

/// 扫描插件根目录，返回全部插件包的清单、解析失败原因与各自的生效窗口尺寸。
///
/// 首次调用会创建插件根目录并在其为空时写入内置示例包。
///
/// **声明为 `async` 是因为扫描要读 SQLite**：每个插件的生效尺寸来自数据库里的插件级
/// 记录与全局默认设置，读库是异步的，同步命令里没有可 await 的上下文。
#[tauri::command]
pub async fn list_plugins(app: AppHandle) -> Result<PluginScanResult, String> {
    plugin::scan_plugin_packages(&app).await
}

/// 打开插件的界面窗口；窗口已存在时只把它调到前台。
///
/// 建窗在 Rust 侧完成，因为能力桥只能随建窗注入（前端窗口选项不透出初始化脚本）。
///
/// **必须声明为 `async`**：同步命令在主线程上执行，而在主线程里建 WebView2 会死锁
/// （完整推导见 [`plugin::open_plugin_window`]）。这里不是「顺手写成异步」，
/// 改成同步会让插件窗口打不开、宿主界面一起卡死。
#[tauri::command]
pub async fn open_plugin_window(app: AppHandle, plugin_id: String) -> Result<(), String> {
    plugin::open_plugin_window(&app, &plugin_id).await
}

/// 读取插件包内文本文件，对应 `fs:read` 能力。
#[tauri::command]
pub fn read_plugin_package_file(
    app: AppHandle,
    window: Window,
    plugin_id: String,
    relative_path: String,
) -> Result<String, String> {
    let plugin_id = plugin::resolve_caller_plugin_id(window.label(), &plugin_id);

    plugin::read_plugin_file(&app, &plugin_id, &relative_path)
}

/// 写入插件包内文本文件，对应 `fs:write` 能力。
#[tauri::command]
pub fn write_plugin_package_file(
    app: AppHandle,
    window: Window,
    plugin_id: String,
    relative_path: String,
    contents: String,
) -> Result<(), String> {
    let plugin_id = plugin::resolve_caller_plugin_id(window.label(), &plugin_id);

    plugin::write_plugin_file(&app, &plugin_id, &relative_path, &contents)
}

/// 追加插件运行日志，对应 `log:write` 能力。
#[tauri::command]
pub fn write_plugin_log(
    app: AppHandle,
    window: Window,
    plugin_id: String,
    level: String,
    message: String,
) -> Result<(), String> {
    let plugin_id = plugin::resolve_caller_plugin_id(window.label(), &plugin_id);

    plugin::write_plugin_log(&app, &plugin_id, &level, &message)
}

/// 发送宿主通知，对应 `ui:notify` 能力。
#[tauri::command]
pub fn notify_from_plugin(
    app: AppHandle,
    window: Window,
    plugin_id: String,
    title: String,
    message: String,
) -> Result<(), String> {
    let plugin_id = plugin::resolve_caller_plugin_id(window.label(), &plugin_id);

    plugin::notify_from_plugin(&app, &plugin_id, &title, &message)
}

/// 读取系统剪贴板文本，对应 `clipboard:read` 能力。
#[tauri::command]
pub fn read_plugin_clipboard_text(
    app: AppHandle,
    window: Window,
    plugin_id: String,
) -> Result<String, String> {
    let plugin_id = plugin::resolve_caller_plugin_id(window.label(), &plugin_id);

    plugin::read_clipboard_text(&app, &plugin_id)
}

/// 写入系统剪贴板文本，对应 `clipboard:write` 能力。
#[tauri::command]
pub fn write_plugin_clipboard_text(
    app: AppHandle,
    window: Window,
    plugin_id: String,
    text: String,
) -> Result<(), String> {
    let plugin_id = plugin::resolve_caller_plugin_id(window.label(), &plugin_id);

    plugin::write_clipboard_text(&app, &plugin_id, &text)
}

/// 代表插件发起 HTTP 请求，对应 `net:request` 能力。
///
/// 刻意声明为异步：请求耗时完全取决于远端，同步命令会让整条 IPC 通道一起等待。
#[tauri::command]
pub async fn plugin_http_request(
    app: AppHandle,
    window: Window,
    plugin_id: String,
    request: PluginHttpRequest,
) -> Result<PluginHttpResponse, String> {
    let plugin_id = plugin::resolve_caller_plugin_id(window.label(), &plugin_id);

    plugin::http_request(&app, &plugin_id, request).await
}

/// 用系统资源管理器打开插件根目录，供用户手工安装插件包。
#[tauri::command]
pub fn open_plugin_root(app: AppHandle) -> Result<(), String> {
    plugin::open_plugin_root(&app)
}
