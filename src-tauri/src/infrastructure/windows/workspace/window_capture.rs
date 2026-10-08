//! 工作区窗口枚举与定位能力。
//!
//! 参考 PowerToys Workspaces 的实现思路：捕获阶段遍历系统顶层窗口，过滤掉
//! 不可见、无标题、工具窗口和 Dasktop 自身窗口，得到可还原的应用窗口快照；
//! 启动阶段再按进程路径拉起应用，并把窗口移动到保存时的位置。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// 单个被捕获的应用窗口。
///
/// 以进程可执行文件路径作为应用身份，因为窗口标题会随文档名变化，
/// 而工作区需要的是"启动哪个应用"，标题只用于界面展示。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceWindow {
    /// 应用专属命令行参数，留空时按系统默认方式启动。
    ///
    /// 多实例应用（如 VS Code）默认会新建窗口，通过 `--reuse-window`
    /// 这类参数可以改为复用已有实例，这是 PowerToys 解决该问题的官方手段。
    #[serde(default)]
    pub arguments: String,
    /// 进程可执行文件绝对路径，启动和去重都以它为准。
    pub executable_path: String,
    /// 窗口高度，单位为物理像素。
    pub height: i32,
    /// 还原时是否让该应用窗口保持最小化。
    ///
    /// 用于把「随工作区一起打开但暂时不需要看」的应用先行收起，
    /// 例如常驻后台的聊天工具或监控面板。默认 false 以保持既有行为。
    #[serde(default)]
    pub minimized: bool,
    /// 窗口标题，仅用于界面展示，不参与还原匹配。
    pub title: String,
    /// 窗口宽度，单位为物理像素。
    pub width: i32,
    /// 窗口左上角 X 坐标，单位为物理像素。
    pub x: i32,
    /// 窗口左上角 Y 坐标，单位为物理像素。
    pub y: i32,
}

/// 枚举当前桌面上可被工作区管理的应用窗口。
///
/// 过滤规则与 PowerToys 保持一致：只保留可见、有标题、非工具窗口，
/// 且排除 Dasktop 自身进程和系统外壳窗口，避免把桌面整理工具自己写进工作区。
#[cfg(target_os = "windows")]
pub(crate) fn capture_visible_windows(
    excluded_executables: &[PathBuf],
) -> Result<Vec<WorkspaceWindow>, String> {
    windows_impl::capture_visible_windows(excluded_executables)
}

/// 非 Windows 平台不提供工作区捕获能力，返回空列表保证调用方无需分支。
#[cfg(not(target_os = "windows"))]
pub(crate) fn capture_visible_windows(
    _excluded_executables: &[PathBuf],
) -> Result<Vec<WorkspaceWindow>, String> {
    Ok(Vec::new())
}

/// 把已存在的窗口移动到保存位置。
///
/// PowerToys 无法指示应用直接启动到指定坐标，只能先启动再移动，
/// 因此这里按进程路径匹配当前所有同进程窗口，全部移动到目标位置。
///
/// `minimize` 为真时窗口定位完成后会被收起，供「默认最小化」的工作区条目使用。
#[cfg(target_os = "windows")]
pub(crate) fn apply_window_placements(
    executable_path: &str,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    minimize: bool,
) -> Result<usize, String> {
    windows_impl::apply_window_placements(executable_path, x, y, width, height, minimize)
}

/// 非 Windows 平台不做窗口定位，返回 0 表示未处理任何窗口。
#[cfg(not(target_os = "windows"))]
pub(crate) fn apply_window_placements(
    _executable_path: &str,
    _x: i32,
    _y: i32,
    _width: i32,
    _height: i32,
    _minimize: bool,
) -> Result<usize, String> {
    Ok(0)
}

/// 启动应用进程，工作区还原时按保存的路径拉起对应程序。
///
/// `arguments` 为应用专属命令行参数，例如 VS Code 的 `--reuse-window`
/// 可以复用已有窗口而不是新建实例；为空时按系统默认方式启动。
#[cfg(target_os = "windows")]
pub(crate) fn launch_executable(
    executable_path: &str,
    arguments: &str,
) -> Result<(), String> {
    windows_impl::launch_executable(executable_path, arguments)
}

/// 非 Windows 平台不支持启动应用。
#[cfg(not(target_os = "windows"))]
pub(crate) fn launch_executable(
    _executable_path: &str,
    _arguments: &str,
) -> Result<(), String> {
    Err("工作区仅支持 Windows 平台".to_owned())
}

/// 判断指定应用当前是否已有可见窗口。
///
/// 用于实现"移动现有窗口"语义：应用已在运行时可以跳过启动步骤，
/// 直接复用现有窗口，避免多实例应用重复开窗。
#[cfg(target_os = "windows")]
pub(crate) fn has_visible_window(executable_path: &str) -> bool {
    windows_impl::has_visible_window(executable_path)
}

/// 非 Windows 平台恒认为应用未运行。
#[cfg(not(target_os = "windows"))]
pub(crate) fn has_visible_window(_executable_path: &str) -> bool {
    false
}

/// 创建指向工作区的桌面快捷方式，让用户脱离 Dasktop 也能启动工作区。
///
/// 快捷方式的目标是 Dasktop 自身可执行文件，参数带上工作区 ID，
/// Dasktop 启动时解析该参数直接还原对应工作区。
#[cfg(target_os = "windows")]
pub(crate) fn create_workspace_shortcut(
    shortcut_path: &std::path::Path,
    target_executable: &str,
    workspace_id: &str,
    workspace_name: &str,
) -> Result<(), String> {
    windows_impl::create_workspace_shortcut(
        shortcut_path,
        target_executable,
        workspace_id,
        workspace_name,
    )
}

/// 非 Windows 平台不支持创建快捷方式。
#[cfg(not(target_os = "windows"))]
pub(crate) fn create_workspace_shortcut(
    _shortcut_path: &std::path::Path,
    _target_executable: &str,
    _workspace_id: &str,
    _workspace_name: &str,
) -> Result<(), String> {
    Err("工作区快捷方式仅支持 Windows 平台".to_owned())
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::path::PathBuf;

    use windows::core::{BOOL, PWSTR};
    use windows::Win32::Foundation::{HWND, LPARAM, MAX_PATH, RECT};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NO_CONSOLE, SHELLEXECUTEINFOW};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowLongPtrW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetWindowPos, ShowWindow,
        SWP_NOACTIVATE, SWP_NOZORDER, SW_MINIMIZE, SW_RESTORE, SW_SHOW, GWL_EXSTYLE,
        WS_EX_TOOLWINDOW,
    };

    use super::WorkspaceWindow;
    use crate::infrastructure::windows::common::wide::null_terminated;

    /// 窗口标题长度上限，超过则跳过，避免把异常超长标题写进数据库。
    const MAX_TITLE_LENGTH: i32 = 1024;

    /// 最小化窗口的哨兵坐标。
    ///
    /// Windows 会把最小化窗口的左上角设为 -32000，任何真实显示器坐标都不会
    /// 到达该值，因此用它做二次拦截可以兜住 IsIconic 尚未生效的短暂状态。
    const MINIMIZED_SENTINEL_COORDINATE: i32 = -30000;

    /// 系统外壳宿主进程黑名单。
    ///
    /// 这些进程自身是可见且有标题的顶层窗口，能通过所有通用过滤条件，
    /// 但它们只是 Windows 用来承载 UWP 应用、系统设置与输入法的外壳，
    /// 用户并不会把它们当作需要还原的应用：
    /// - `applicationframehost.exe` 托管「设置」「计算器」等 UWP 应用的外框；
    /// - `systemsettings.exe` 是「设置」应用本体，与外框宿主成对出现；
    /// - `textinputhost.exe` 是输入法候选框宿主，常见于全屏尺寸但不显示内容；
    /// - `shellexperiencehost.exe` 承载音量、亮度、网络等系统浮出面板；
    /// - `startmenuexperiencehost.exe` 与 `searchhost.exe` 分别是开始菜单与搜索界面。
    ///
    /// 还原这些窗口没有意义，因此按进程名整体排除。
    const EXCLUDED_SYSTEM_HOST_PROCESSES: &[&str] = &[
        "applicationframehost.exe",
        "searchhost.exe",
        "shellexperiencehost.exe",
        "startmenuexperiencehost.exe",
        "systemsettings.exe",
        "textinputhost.exe",
    ];

    /// ShellExecute 的打开动作动词，使用命名常量避免散落 `open` 字面量。
    const SHELL_OPEN_VERB: &str = "open";

    /// 枚举过程中收集到的原始窗口条目，回调闭包只能通过 LPARAM 传递可变状态。
    struct EnumerationState {
        excluded_executables: Vec<PathBuf>,
        windows: Vec<WorkspaceWindow>,
    }

    /// 捕获当前桌面上符合条件的应用窗口。
    pub(super) fn capture_visible_windows(
        excluded_executables: &[PathBuf],
    ) -> Result<Vec<WorkspaceWindow>, String> {
        let mut state = EnumerationState {
            excluded_executables: excluded_executables.to_vec(),
            windows: Vec::new(),
        };

        // SAFETY: 回调只通过 LPARAM 读写 state，枚举期间 state 保持独占可变借用，
        // 不存在别名访问；EnumWindows 返回后回调不再执行。
        unsafe {
            EnumWindows(Some(enum_windows_callback), LPARAM(&mut state as *mut _ as isize))
                .map_err(|error| format!("枚举窗口失败: {error}"))?;
        }

        Ok(state.windows)
    }

    /// EnumWindows 回调，逐个判断窗口是否符合工作区收录条件。
    unsafe extern "system" fn enum_windows_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let state = &mut *(lparam.0 as *mut EnumerationState);

        if let Some(window) = collect_window(hwnd, &state.excluded_executables) {
            // 同一进程可能有多个窗口，保留先枚举到的那个作为该应用的代表位置。
            let already_recorded = state
                .windows
                .iter()
                .any(|item| item.executable_path == window.executable_path);

            if !already_recorded {
                state.windows.push(window);
            }
        }

        true.into()
    }

    /// 读取单个窗口信息，不满足收录条件时返回 None。
    unsafe fn collect_window(
        hwnd: HWND,
        excluded_executables: &[PathBuf],
    ) -> Option<WorkspaceWindow> {
        if !IsWindowVisible(hwnd).as_bool() {
            return None;
        }

        // 工具窗口通常是悬浮面板、输入法候选框等，不属于用户主动打开的应用。
        let extended_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        if extended_style & WS_EX_TOOLWINDOW.0 != 0 {
            return None;
        }

        let title = read_window_title(hwnd)?;
        let executable_path = read_window_executable(hwnd)?;
        let executable_buffer = PathBuf::from(&executable_path);

        if excluded_executables.iter().any(|excluded| excluded == &executable_buffer) {
            return None;
        }

        // 系统外壳宿主自身是可见有标题的窗口，但还原它们没有任何意义，
        // 且会把「设置」这类 UWP 应用误记成 ApplicationFrameHost。
        if is_system_host_process(&executable_buffer) {
            return None;
        }

        // 最小化窗口的 GetWindowRect 会返回 (-32000, -32000) 这类哨兵坐标，
        // 且尺寸退化成标题栏大小（如 160x28），正数检查无法拦截，
        // 必须靠 IsIconic 显式判断，否则会把无意义的条目写进工作区。
        if IsIconic(hwnd).as_bool() {
            return None;
        }

        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return None;
        }

        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if width <= 0 || height <= 0 {
            return None;
        }

        // 兜底拦截哨兵坐标：个别窗口在 IsIconic 返回前已被系统移到该位置。
        if rect.left <= MINIMIZED_SENTINEL_COORDINATE || rect.top <= MINIMIZED_SENTINEL_COORDINATE {
            return None;
        }

        Some(WorkspaceWindow {
            arguments: String::new(),
            executable_path,
            height,
            minimized: false,
            title,
            width,
            x: rect.left,
            y: rect.top,
        })
    }

    /// 判断可执行文件是否属于系统外壳宿主进程。
    ///
    /// 只比对文件名且忽略大小写：Windows 路径大小写不敏感，
    /// 而这些系统进程的安装位置在不同版本间可能变化，用全路径匹配并不可靠。
    fn is_system_host_process(executable_path: &std::path::Path) -> bool {
        let Some(file_name) = executable_path.file_name() else {
            return false;
        };

        let normalized = file_name.to_string_lossy().to_ascii_lowercase();

        EXCLUDED_SYSTEM_HOST_PROCESSES.contains(&normalized.as_str())
    }

    /// 读取窗口标题，空标题或异常长度返回 None。
    unsafe fn read_window_title(hwnd: HWND) -> Option<String> {
        let length = GetWindowTextLengthW(hwnd);
        if length <= 0 || length > MAX_TITLE_LENGTH {
            return None;
        }

        let mut buffer = vec![0u16; length as usize + 1];
        let copied = GetWindowTextW(hwnd, &mut buffer);
        if copied <= 0 {
            return None;
        }

        Some(String::from_utf16_lossy(&buffer[..copied as usize]))
    }

    /// 通过窗口所属进程读取可执行文件绝对路径。
    unsafe fn read_window_executable(hwnd: HWND) -> Option<String> {
        let mut process_id = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));
        if process_id == 0 {
            return None;
        }

        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id).ok()?;
        let mut buffer = vec![0u16; MAX_PATH as usize];

        // QueryFullProcessImageNameW 返回 Result，失败时说明进程已退出或权限不足。
        let mut buffer_length = buffer.len() as u32;
        let result = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_FORMAT(0),
            PWSTR(buffer.as_mut_ptr()),
            &mut buffer_length,
        );
        let _ = process; // 句柄由 windows crate 在 drop 时自动关闭。

        if result.is_err() {
            return None;
        }

        let length = buffer.iter().position(|value| *value == 0)?;
        if length == 0 {
            return None;
        }

        let path = OsString::from_wide(&buffer[..length]);
        Some(PathBuf::from(path).to_string_lossy().into_owned())
    }

    /// 把指定进程的所有可见窗口移动到目标位置。
    ///
    /// 保存的坐标若是最小化哨兵值（早期版本误捕获的脏数据），
    /// 移动过去会把窗口送到屏幕外，因此直接跳过并返回 0。
    ///
    /// `minimize` 为真时，窗口先被移动到目标坐标再收起。顺序不能颠倒：
    /// 直接最小化会让坐标退化成哨兵值，用户展开窗口时就丢失了保存的位置。
    pub(super) fn apply_window_placements(
        executable_path: &str,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        minimize: bool,
    ) -> Result<usize, String> {
        if x <= MINIMIZED_SENTINEL_COORDINATE || y <= MINIMIZED_SENTINEL_COORDINATE {
            return Ok(0);
        }

        let mut state = PlacementState {
            executable_path: PathBuf::from(executable_path),
            minimize,
            moved_count: 0,
            target: (x, y, width, height),
        };

        // SAFETY: 与捕获阶段同理，回调仅通过 LPARAM 访问 state。
        unsafe {
            EnumWindows(Some(place_window_callback), LPARAM(&mut state as *mut _ as isize))
                .map_err(|error| format!("定位窗口失败: {error}"))?;
        }

        Ok(state.moved_count)
    }

    /// 窗口定位过程中的可变状态。
    struct PlacementState {
        executable_path: PathBuf,
        /// 定位完成后是否收起窗口。
        minimize: bool,
        moved_count: usize,
        target: (i32, i32, i32, i32),
    }

    /// EnumWindows 回调，把匹配进程的窗口移动到保存位置。
    unsafe extern "system" fn place_window_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let state = &mut *(lparam.0 as *mut PlacementState);

        if !IsWindowVisible(hwnd).as_bool() {
            return true.into();
        }

        let Some(executable_path) = read_window_executable(hwnd) else {
            return true.into();
        };

        if state.executable_path.as_os_str() != executable_path.as_str() {
            return true.into();
        }

        // 最小化窗口需要先还原，否则 SetWindowPos 不会改变其恢复位置。
        let _ = ShowWindow(hwnd, SW_RESTORE);

        let (x, y, width, height) = state.target;
        let moved = SetWindowPos(
            hwnd,
            None,
            x,
            y,
            width,
            height,
            SWP_NOACTIVATE | SWP_NOZORDER,
        );

        if moved.is_ok() {
            state.moved_count += 1;
        }

        // 先定位再收起：直接最小化会让坐标退化成哨兵值，
        // 用户展开窗口时就无法回到保存的位置。
        if state.minimize {
            let _ = ShowWindow(hwnd, SW_MINIMIZE);
        }

        true.into()
    }

    /// 判断指定应用当前是否已有可见窗口。
    ///
    /// 与定位逻辑共用同一套进程路径匹配规则，保证判断结果和
    /// 后续移动操作针对的是同一批窗口。
    pub(super) fn has_visible_window(executable_path: &str) -> bool {
        let mut state = VisibilityState {
            executable_path: PathBuf::from(executable_path),
            found: false,
        };

        // SAFETY: 回调仅通过 LPARAM 访问 state，枚举结束前 state 保持独占借用。
        unsafe {
            let _ = EnumWindows(
                Some(visibility_callback),
                LPARAM(&mut state as *mut _ as isize),
            );
        }

        state.found
    }

    /// 可见性检测过程中的可变状态。
    struct VisibilityState {
        executable_path: PathBuf,
        found: bool,
    }

    /// EnumWindows 回调，命中目标进程即结束枚举。
    ///
    /// 返回 FALSE 会让 EnumWindows 提前停止，避免遍历完整个窗口列表。
    unsafe extern "system" fn visibility_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let state = &mut *(lparam.0 as *mut VisibilityState);

        if !IsWindowVisible(hwnd).as_bool() {
            return true.into();
        }

        let Some(executable_path) = read_window_executable(hwnd) else {
            return true.into();
        };

        if state.executable_path.as_os_str() == executable_path.as_str() {
            state.found = true;
            return false.into();
        }

        true.into()
    }

    /// 通过 Shell 执行启动应用，使用系统默认方式打开可执行文件。
    ///
    /// 带参数时走 `lpParameters` 通道，参数按应用各自约定传入；
    /// 不带参数时传 None，保持与系统默认双击完全一致的行为。
    ///
    /// 使用 `ShellExecuteExW` 而非 `ShellExecuteW`，目的是附加
    /// `SEE_MASK_NO_CONSOLE`：该标志让被启动进程不继承调用方的控制台。
    /// 开发态下 Dasktop 由 `cargo run` 启动、自身挂在终端控制台上，
    /// 若不加此标志，被拉起的应用（尤其是 Electron 类）会把日志直接
    /// 打进 Dasktop 的终端，污染开发输出。Shell 语义（verb、文件关联、
    /// UAC 提权）保持不变。
    pub(super) fn launch_executable(executable_path: &str, arguments: &str) -> Result<(), String> {
        let operation = null_terminated(SHELL_OPEN_VERB);
        let file = null_terminated(executable_path);
        let parameters = if arguments.trim().is_empty() {
            None
        } else {
            Some(null_terminated(arguments))
        };
        let parameters_pointer = parameters
            .as_ref()
            .map_or(windows::core::PCWSTR::null(), |value| {
                windows::core::PCWSTR(value.as_ptr())
            });

        let mut execute_info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NO_CONSOLE,
            lpVerb: windows::core::PCWSTR(operation.as_ptr()),
            lpFile: windows::core::PCWSTR(file.as_ptr()),
            lpParameters: parameters_pointer,
            nShow: SW_SHOW.0,
            ..Default::default()
        };

        // SAFETY: execute_info 在调用期间保持存活，cbSize 已按结构体实际大小填写，
        // 三个 PCWSTR 指向的缓冲区也都以零结尾且活过本次调用；hwnd / lpDirectory
        // 保持默认空指针是合法缺省值。
        let result = unsafe { ShellExecuteExW(&mut execute_info) };

        // ShellExecuteExW 通过 Result 返回成败，内部已把 BOOL 转换过。
        if result.is_err() {
            return Err(format!("启动应用失败: {executable_path}"));
        }

        Ok(())
    }

    /// 创建工作区快捷方式，目标指向 Dasktop 自身并携带工作区 ID 参数。
    pub(super) fn create_workspace_shortcut(
        shortcut_path: &std::path::Path,
        target_executable: &str,
        workspace_id: &str,
        workspace_name: &str,
    ) -> Result<(), String> {
        use windows::core::{Interface, PCWSTR};
        use windows::Win32::System::Com::{CoCreateInstance, IPersistFile, CLSCTX_INPROC_SERVER};
        use windows::Win32::System::Ole::OleInitialize;
        use windows::Win32::UI::Shell::{IShellLinkW, ShellLink, SLGP_RAWPATH};

        // 直接覆盖同名快捷方式：用户重新点击「创建快捷方式」通常是想刷新
        // 目标路径或参数，此时拒绝创建反而需要用户手动先去桌面删除。
        let target_wide = null_terminated(target_executable);
        let arguments_wide = null_terminated(&format!("--workspace {workspace_id}"));
        let shortcut_wide = wide_path(shortcut_path);

        // SAFETY: 所有 UTF-16 缓冲区在调用期间保持存活；COM 接口由 windows crate
        // 管理引用计数，Save 完成后即时释放。
        unsafe {
            let _ = OleInitialize(None);
            let shell_link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
                .map_err(|error| format!("无法创建快捷方式对象: {error}"))?;
            shell_link
                .SetPath(PCWSTR(target_wide.as_ptr()))
                .map_err(|error| format!("无法写入快捷方式目标: {error}"))?;
            shell_link
                .SetArguments(PCWSTR(arguments_wide.as_ptr()))
                .map_err(|error| format!("无法写入快捷方式参数: {error}"))?;
            shell_link
                .SetDescription(PCWSTR(null_terminated(&format!("启动工作区 {workspace_name}")).as_ptr()))
                .map_err(|error| format!("无法写入快捷方式描述: {error}"))?;

            // Windows 会把未显式设置图标的快捷方式显示成默认图标，
            // 这里直接沿用目标程序图标，让快捷方式在桌面上可辨认。
            let _ = shell_link.SetIconLocation(PCWSTR(target_wide.as_ptr()), 0);
            let _ = SLGP_RAWPATH;

            let persist_file: IPersistFile = shell_link
                .cast()
                .map_err(|error| format!("无法保存快捷方式: {error}"))?;
            persist_file
                .Save(PCWSTR(shortcut_wide.as_ptr()), true)
                .map_err(|error| format!("无法保存快捷方式: {error}"))?;
        }

        Ok(())
    }

    /// 将路径转成 Windows API 需要的 UTF-16 零结尾缓冲区。
    fn wide_path(path: &std::path::Path) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;

        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }
}
