//! 插件服务层。
//!
//! 负责三件事：把「应用数据目录」翻译成插件根目录、把基础设施的包内文件操作包装成
//! 面向插件 id 的用例、把宿主通知落到 Tauri 事件上。
//!
//! 插件界面是插件作者自己写的网页，宿主通过 `plugin` 自定义协议把这些文件喂给插件
//! 窗口（见 [`protocol`]），因此这里没有「加载插件代码」这一步——宿主从不执行插件
//! 的逻辑，只负责把它的页面交出去。

mod protocol;

pub use protocol::handle_plugin_asset_request;

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::domain::plugin::{
    PluginHttpRequest, PluginHttpResponse, PluginScanResult, PLUGIN_LOG_DIR_NAME,
    PLUGIN_NOTIFICATION_EVENT, PLUGIN_PROTOCOL_SCHEME, PLUGIN_ROOT_DIR_NAME,
};
use crate::infrastructure::filesystem::{plugin_log, plugin_package};
use crate::infrastructure::http;
use crate::infrastructure::windows::shell_file;

/// 宿主转发给界面的插件通知载荷。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginNotificationPayload {
    /// 通知来源插件 id，界面据此标注发起方。
    pub plugin_id: String,
    /// 通知标题。
    pub title: String,
    /// 通知正文。
    pub message: String,
    /// 通知产生时间（毫秒时间戳），界面按此排序并做去重展示。
    pub created_at: u64,
}

/// 扫描全部插件包。
///
/// 首次运行时插件根目录不存在会先被创建并补写内置示例包，让「插件」设置页在全新安装后
/// 就有可展示的内容，而不是一个空目录加一句无从下手的提示。
pub fn scan_plugin_packages(app: &AppHandle) -> Result<PluginScanResult, String> {
    let root = resolve_plugin_root(app)?;
    plugin_package::seed_sample_package_if_empty(&root)?;

    plugin_package::scan_packages(&root)
}

/// 插件页面资源的 URL 前缀，按平台给出。
///
/// WebView 对自定义协议的寻址方式并不跨平台一致：Windows（WebView2）与 Android 把它
/// 映射成 `http://<scheme>.localhost`，其余平台是 `<scheme>://localhost`。前端据此拼接
/// `/<插件id>/<相对路径>`，所以这条平台判断只放在这里一处，前端不重复实现一遍。
pub fn asset_base_url() -> String {
    if cfg!(any(windows, target_os = "android")) {
        format!("http://{PLUGIN_PROTOCOL_SCHEME}.localhost")
    } else {
        format!("{PLUGIN_PROTOCOL_SCHEME}://localhost")
    }
}

/// 读取插件包内文本文件，对应 `fs:read` 能力。
pub fn read_plugin_file(
    app: &AppHandle,
    plugin_id: &str,
    relative_path: &str,
) -> Result<String, String> {
    let package_dir = resolve_package_dir(app, plugin_id)?;

    plugin_package::read_package_file(&package_dir, relative_path)
}

/// 写入插件包内文本文件，对应 `fs:write` 能力。
pub fn write_plugin_file(
    app: &AppHandle,
    plugin_id: &str,
    relative_path: &str,
    contents: &str,
) -> Result<(), String> {
    let package_dir = resolve_package_dir(app, plugin_id)?;

    plugin_package::write_package_file(&package_dir, relative_path, contents)
}

/// 追加插件运行日志，对应 `log:write` 能力。
///
/// 这里不校验插件包是否存在：日志是排查手段，插件包被删掉之后仍应能留下最后一条记录。
/// 但 id 必须过白名单校验——它直接参与日志文件名拼接。
pub fn write_plugin_log(
    app: &AppHandle,
    plugin_id: &str,
    level: &str,
    message: &str,
) -> Result<(), String> {
    if !plugin_package::is_valid_plugin_id(plugin_id) {
        return Err(format!("非法插件 id：{plugin_id}"));
    }

    let log_dir = resolve_log_dir(app)?;

    plugin_log::append_log(&log_dir, plugin_id, level, message)
}

/// 发送宿主通知，对应 `ui:notify` 能力。
///
/// 通知同时落日志：宿主界面不可见时（例如自启静默驻留托盘期间）事件没有订阅者，
/// 此时日志是唯一能回溯插件行为的通道。
pub fn notify_from_plugin(
    app: &AppHandle,
    plugin_id: &str,
    title: &str,
    message: &str,
) -> Result<(), String> {
    write_plugin_log(app, plugin_id, "notify", &format!("{title}：{message}"))?;

    let payload = PluginNotificationPayload {
        plugin_id: plugin_id.to_string(),
        title: title.to_string(),
        message: message.to_string(),
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or_default(),
    };

    app.emit(PLUGIN_NOTIFICATION_EVENT, payload)
        .map_err(|error| format!("插件通知广播失败：{error}"))
}

/// 代表插件发起 HTTP 请求，对应 `net:request` 能力。
///
/// 发起与完成各记一行日志：网络能力是插件里最难复现的一类行为，出问题时
/// 「发过哪些请求、最终什么状态」往往比插件自己的报错更有定位价值。
/// 失败路径只留下「发起」那一行，正好说明请求没有拿到响应。
pub async fn http_request(
    app: &AppHandle,
    plugin_id: &str,
    request: PluginHttpRequest,
) -> Result<PluginHttpResponse, String> {
    if !plugin_package::is_valid_plugin_id(plugin_id) {
        return Err(format!("非法插件 id：{plugin_id}"));
    }

    let method = request
        .method
        .as_deref()
        .map(|value| value.trim().to_ascii_uppercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "GET".to_string());

    write_plugin_log(app, plugin_id, "net", &format!("{method} {}", request.url))?;

    let response = http::send(&request).await?;

    write_plugin_log(
        app,
        plugin_id,
        "net",
        &format!("{method} {} -> {}", request.url, response.status),
    )?;

    Ok(response)
}

/// 用系统资源管理器打开插件根目录，方便用户手工安装或替换插件包。
pub fn open_plugin_root(app: &AppHandle) -> Result<(), String> {
    let root = resolve_plugin_root(app)?;
    plugin_package::ensure_root(&root)?;

    shell_file::open_folder_in_explorer(&root.to_string_lossy())
}

/// 解析插件根目录路径；只计算路径，不保证目录已经存在。
fn resolve_plugin_root(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法解析应用数据目录：{error}"))?;

    Ok(data_dir.join(PLUGIN_ROOT_DIR_NAME))
}

/// 解析插件日志目录路径。
fn resolve_log_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法解析应用数据目录：{error}"))?;

    Ok(data_dir.join(PLUGIN_LOG_DIR_NAME))
}

/// 定位插件包目录，同时挡住非法 id 用路径分隔符越权。
fn resolve_package_dir(app: &AppHandle, plugin_id: &str) -> Result<PathBuf, String> {
    let root = resolve_plugin_root(app)?;

    plugin_package::resolve_package_dir(&root, plugin_id)
}
