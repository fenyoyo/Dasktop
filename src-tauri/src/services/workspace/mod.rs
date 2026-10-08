//! 工作区服务编排窗口捕获、应用启动、位置还原和快捷方式创建四类系统操作。
//!
//! PowerToys 无法指示应用直接启动到指定坐标，只能先拉起进程再移动窗口，
//! 因此还原流程是：逐个启动缺失进程，等待窗口出现，再统一移动到位。

use std::path::Path;
use std::path::PathBuf;
use std::thread::sleep;
use std::time::Duration;

use crate::infrastructure::windows::workspace::{
    apply_window_placements, capture_visible_windows, create_workspace_shortcut,
    has_visible_window, launch_executable, WorkspaceWindow,
};

/// 单次还原中等待窗口出现的轮询间隔。
const WINDOW_POLL_INTERVAL: Duration = Duration::from_millis(150);

/// 单个应用等待窗口出现的总时长上限。
///
/// 应用冷启动差异很大，Electron 类应用可能超过 3 秒，这里给足余量；
/// 超时后仍会尝试定位一次，避免已启动但响应慢的窗口被完全放弃。
const WINDOW_WAIT_TIMEOUT: Duration = Duration::from_secs(8);

/// 捕获当前桌面的应用窗口布局。
///
/// 排除列表由调用方传入，用于跳过 Dasktop 自身进程，避免把桌面整理工具
/// 自己写进工作区导致还原时反复拉起设置窗口。
pub fn capture_current_layout(
    excluded_executables: Vec<String>,
) -> Result<Vec<WorkspaceWindow>, String> {
    let excluded_paths = excluded_executables
        .into_iter()
        .map(PathBuf::from)
        .collect::<Vec<_>>();

    capture_visible_windows(&excluded_paths)
}

/// 按保存的窗口列表还原应用布局。
///
/// 返回每个应用的处理结果，供前端展示启动状态，与 PowerToys 的状态对话框语义一致。
///
/// 应用已在运行时跳过启动步骤直接定位，避免多实例应用重复开窗；
/// 该行为与 PowerToys 的「移动现有窗口」选项一致。
pub fn restore_layout(
    windows: Vec<WorkspaceWindow>,
) -> Result<Vec<WorkspaceRestoreResult>, String> {
    let mut results = Vec::with_capacity(windows.len());

    for window in windows {
        // 已有可见窗口说明应用处于运行状态，直接复用而不是再启一个实例。
        let already_running = has_visible_window(&window.executable_path);

        if !already_running {
            let launch_result = launch_executable(&window.executable_path, &window.arguments);
            if let Err(error) = launch_result {
                results.push(WorkspaceRestoreResult {
                    executable_path: window.executable_path,
                    message: error,
                    reused_existing: false,
                    success: false,
                });
                continue;
            }
        }

        // 已存在实例时窗口已经就绪，轮询能在第一时间命中；
        // 冷启动则需要等待进程创建窗口。
        let moved_count = wait_and_place(&window)?;
        results.push(WorkspaceRestoreResult {
            executable_path: window.executable_path,
            message: if moved_count > 0 {
                String::new()
            } else {
                "应用已启动，但未找到可定位的窗口".to_owned()
            },
            reused_existing: already_running && moved_count > 0,
            success: moved_count > 0,
        });
    }

    Ok(results)
}

/// 轮询等待目标应用窗口出现，出现后立即移动并调整尺寸。
///
/// 是否在定位后收起窗口由 `window.minimized` 决定，
/// 该标记随工作区一起持久化，用户可以按应用逐个配置。
fn wait_and_place(window: &WorkspaceWindow) -> Result<usize, String> {
    let deadline = std::time::Instant::now() + WINDOW_WAIT_TIMEOUT;

    loop {
        let moved_count = apply_window_placements(
            &window.executable_path,
            window.x,
            window.y,
            window.width,
            window.height,
            window.minimized,
        )?;

        if moved_count > 0 {
            return Ok(moved_count);
        }

        if std::time::Instant::now() >= deadline {
            return Ok(0);
        }

        sleep(WINDOW_POLL_INTERVAL);
    }
}

/// 在桌面创建指向工作区的快捷方式。
///
/// 快捷方式目标是 Dasktop 自身并携带工作区 ID，用户固定到任务栏后
/// 可以不经过设置页直接启动工作区。
pub fn create_shortcut(
    desktop_path: &str,
    workspace_id: &str,
    workspace_name: &str,
) -> Result<String, String> {
    let target_executable = std::env::current_exe()
        .map_err(|error| format!("读取当前进程路径失败: {error}"))?
        .to_string_lossy()
        .into_owned();

    let shortcut_path = Path::new(desktop_path).join(format!(
        "{}.lnk",
        sanitize_shortcut_name(workspace_name)
    ));

    create_workspace_shortcut(&shortcut_path, &target_executable, workspace_id, workspace_name)?;

    Ok(shortcut_path.to_string_lossy().into_owned())
}

/// 工作区名称会被用作文件名，剔除 Windows 文件名非法字符避免创建失败。
fn sanitize_shortcut_name(name: &str) -> String {
    let sanitized = name
        .chars()
        .map(|character| {
            if matches!(character, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                character
            }
        })
        .collect::<String>()
        .trim()
        .to_owned();

    if sanitized.is_empty() {
        "工作区".to_owned()
    } else {
        sanitized
    }
}

/// 单个应用的还原结果，用于设置页展示启动状态。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRestoreResult {
    /// 应用可执行文件路径，前端据此匹配展示名称。
    pub executable_path: String,
    /// 失败原因，成功时为空字符串。
    pub message: String,
    /// 该应用是否复用了已运行的实例，前端据此展示差异化状态文案。
    pub reused_existing: bool,
    /// 该应用是否成功启动并定位。
    pub success: bool,
}

/// 解析命令行中的工作区参数。
///
/// 覆盖本进程直接由快捷方式启动的场景：桌面快捷方式以 Dasktop 自身为
/// 目标并携带 `--workspace <id>`，参数就在当前进程的 `argv` 里。
///
/// 没有该参数时返回 None，保持普通启动路径不受影响。
pub fn resolve_startup_workspace_id() -> Option<String> {
    let arguments = std::env::args().collect::<Vec<_>>();

    parse_workspace_argument(arguments.iter().map(String::as_str))
}

/// 从命令行参数中提取 `--workspace` 后面的工作区 ID。
///
/// 同时服务两类调用方：本进程的 `argv`，以及单实例通道转交过来的参数串。
/// 两者都以 `&str` 迭代器表达，避免其中一方做多余的 String 分配。
pub(crate) fn parse_workspace_argument<'a>(
    arguments: impl Iterator<Item = &'a str>,
) -> Option<String> {
    let collected = arguments.collect::<Vec<_>>();

    collected
        .iter()
        .position(|argument| *argument == "--workspace")
        .and_then(|index| collected.get(index + 1))
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_owned())
}

/// 批量解析应用可执行文件的图标。
///
/// 工作区列表只展示应用名时辨识度偏低，这里直接把 Shell 解析出的
/// 真实图标交给前端，让用户一眼认出每个条目对应哪个应用。
///
/// 解析失败的条目不会出现在结果中，由前端回退到首字母占位图标，
/// 因此这里不需要返回错误——单个应用取不到图标不应影响整体展示。
pub fn resolve_executable_icons(
    executable_paths: Vec<String>,
) -> std::collections::HashMap<String, String> {
    let mut icons = std::collections::HashMap::with_capacity(executable_paths.len());

    for executable_path in executable_paths {
        let Some(icon_data_url) =
            crate::infrastructure::windows::shell_icon::resolve_item_icon_data_url(Path::new(
                &executable_path,
            ))
        else {
            continue;
        };

        icons.insert(executable_path, icon_data_url);
    }

    icons
}
