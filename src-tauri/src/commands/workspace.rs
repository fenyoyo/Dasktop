//! 工作区命令层，只做 IPC 参数接收和服务转发，业务规则全部下沉到 services。

use crate::infrastructure::windows::workspace::WorkspaceWindow;
use crate::services::workspace;

/// 捕获当前桌面的应用窗口布局，供前端保存成工作区。
///
/// 排除列表由前端传入 Dasktop 自身进程路径，避免把设置窗口写进工作区。
#[tauri::command]
pub fn capture_workspace_layout(
    excluded_executables: Vec<String>,
) -> Result<Vec<WorkspaceWindow>, String> {
    workspace::capture_current_layout(excluded_executables)
}

/// 按保存的窗口列表启动应用并还原窗口位置。
#[tauri::command]
pub fn restore_workspace_layout(
    windows: Vec<WorkspaceWindow>,
) -> Result<Vec<workspace::WorkspaceRestoreResult>, String> {
    workspace::restore_layout(windows)
}

/// 返回当前 Dasktop 进程的可执行文件路径，供前端构造工作区排除列表。
#[tauri::command]
pub fn resolve_current_executable_path() -> Result<String, String> {
    std::env::current_exe()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| format!("读取当前进程路径失败: {error}"))
}

/// 在桌面创建工作区快捷方式，返回快捷方式完整路径。
#[tauri::command]
pub fn create_workspace_desktop_shortcut(
    desktop_path: String,
    workspace_id: String,
    workspace_name: String,
) -> Result<String, String> {
    workspace::create_shortcut(&desktop_path, &workspace_id, &workspace_name)
}

/// 读取启动命令行中的工作区参数。
///
/// 有两条来源需要覆盖：
/// - 本进程直接由快捷方式启动时，参数就在自己的 `argv` 里；
/// - 主实例已运行、快捷方式触发了二次启动时，参数由单实例通道转交过来。
///
/// 前端挂载后调用本命令获取 ID，命中则直接还原工作区，未携带时返回 null。
#[tauri::command]
pub fn resolve_startup_workspace_id() -> Option<String> {
    if let Some(workspace_id) = workspace::resolve_startup_workspace_id() {
        return Some(workspace_id);
    }

    crate::infrastructure::windows::single_instance::take_pending_startup_argument()
        .and_then(|argument| workspace::parse_workspace_argument(argument.split_whitespace()))
}
/// 批量解析应用可执行文件的图标，供工作区列表展示以提升辨识度。
///
/// 前端传入可执行文件路径列表，返回「路径 → data URL」的映射；
/// 解析失败的条目直接不出现在结果里，由前端回退到首字母占位图标。
#[tauri::command]
pub fn resolve_executable_icons(executable_paths: Vec<String>) -> std::collections::HashMap<String, String> {
    workspace::resolve_executable_icons(executable_paths)
}
