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
    has_visible_window, launch_executable, run_shell_command, WorkspaceWindow,
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

/// 按保存的窗口列表还原应用布局，并执行工作区的附加命令。
///
/// 返回应用的还原结果和命令的执行结果，供前端展示启动状态，
/// 与 PowerToys 的状态对话框语义一致。
///
/// 应用已在运行时跳过启动步骤直接定位，避免多实例应用重复开窗；
/// 该行为与 PowerToys 的「移动现有窗口」选项一致。
///
/// `windows` 的数组顺序就是启动顺序，前端通过上移/下移调整。
/// `launch_interval_seconds` 是相邻两次启动之间的固定等待秒数，0 表示不等待：
/// 连续启动多个重型应用会同时抢占磁盘与 CPU，错峰启动能明显改善启动过程。
/// `commands` 是应用全部还原完成后按填写顺序执行的附加命令，用于补齐
/// 「应用起来了但服务还没起来」的场景，例如 Docker Desktop 启动后执行
/// `docker start mysql`。
pub fn restore_layout(
    windows: Vec<WorkspaceWindow>,
    launch_interval_seconds: u32,
    commands: Vec<String>,
) -> Result<WorkspaceRestoreOutcome, String> {
    let mut results = Vec::with_capacity(windows.len());
    // 已真正启动过的应用数量：间隔只服务于错峰启动，
    // 复用了运行中实例的应用没有启动开销，不应该占用等待时间。
    let mut launched_count = 0usize;

    for window in windows {
        // 已有可见窗口说明应用处于运行状态，直接复用而不是再启一个实例。
        let already_running = has_visible_window(&window.executable_path);

        if !already_running {
            // 第一个启动的应用立即拉起，之后的每个应用先等待设定间隔，
            // 把连续启动错开，而不是让所有进程同时争抢资源。
            if launched_count > 0 && launch_interval_seconds > 0 {
                sleep(Duration::from_secs(u64::from(launch_interval_seconds)));
            }

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

            launched_count += 1;
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

    // 附加命令放在应用之后：命令都是启动宿主应用之后的收尾动作，
    // 例如 Docker 的 `docker start mysql` 必须先有 Docker Desktop 在跑。
    let command_results = run_commands(&commands);

    Ok(WorkspaceRestoreOutcome {
        commands: command_results,
        windows: results,
    })
}

/// 按填写顺序逐条执行附加命令。
///
/// 顺序执行而不是并发：命令之间常有依赖（先起容器再初始化数据），
/// 并发执行会让输出交错、失败原因难以定位。
fn run_commands(commands: &[String]) -> Vec<WorkspaceCommandResult> {
    let mut results = Vec::with_capacity(commands.len());

    for command in commands {
        // 允许列表里保留占位行，空命令直接跳过而不是报错。
        let trimmed = command.trim();
        if trimmed.is_empty() {
            continue;
        }

        let (success, message) = match run_shell_command(trimmed) {
            Ok(output) => (true, output),
            Err(error) => (false, error),
        };

        results.push(WorkspaceCommandResult {
            command: trimmed.to_owned(),
            message,
            success,
        });
    }

    results
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

/// 一次工作区还原的完整结果。
///
/// 拆成应用与命令两个列表而不是合成一个：两者身份来源不同（应用靠可执行
/// 文件路径匹配、命令靠填写顺序匹配），分开返回让前端各自映射，
/// 不需要再引入类型判别字段。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRestoreOutcome {
    /// 附加命令的执行结果，按填写顺序返回。
    pub commands: Vec<WorkspaceCommandResult>,
    /// 应用窗口的还原结果，顺序与传入的窗口列表一致。
    pub windows: Vec<WorkspaceRestoreResult>,
}

/// 单条附加命令的执行结果，用于设置页展示执行状态。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCommandResult {
    /// 用户填写的原始命令，前端据此匹配展示条目。
    pub command: String,
    /// 失败原因或命令输出摘要，成功且无输出时为空字符串。
    pub message: String,
    /// 该命令是否以 0 退出。
    pub success: bool,
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
