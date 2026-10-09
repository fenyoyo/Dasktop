//! 插件服务层。
//!
//! 负责三件事：把「应用数据目录」翻译成插件根目录、把基础设施的包内文件操作包装成
//! 面向插件 id 的用例、把宿主通知落到 Tauri 事件上。
//!
//! 这里不做权限判断：权限门控由前端上下文层负责，命令层与服务层都按「调用方已授权」
//! 的前提工作。这条边界的代价是后端命令可被直接调用，收益是宿主能力扩展只需在前端加
//! 一行映射；当前版本接受该权衡，隔离方案见 `docs/plugin-package-framework.md` 的局限章节。

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::domain::plugin::{
    PluginScanResult, PLUGIN_LOG_DIR_NAME, PLUGIN_NOTIFICATION_EVENT, PLUGIN_ROOT_DIR_NAME,
};
use crate::infrastructure::filesystem::{plugin_log, plugin_package};
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

/// 读取插件入口源码，交由前端包装成模块后执行。
pub fn read_plugin_entry(app: &AppHandle, plugin_id: &str) -> Result<String, String> {
    let package_dir = resolve_package_dir(app, plugin_id)?;
    let manifest = plugin_package::read_manifest(&package_dir)?;

    plugin_package::read_entry_source(&package_dir, &manifest)
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
