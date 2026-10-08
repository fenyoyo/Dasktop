//! Windows 单实例控制，负责阻止重复进程并把二次启动转换成主实例内的唤起动作。
//!
//! 二次启动不仅仅是「再打开设置页」：工作区快捷方式会以 `--workspace <id>`
//! 的形式启动 Dasktop，如果此时主实例已在运行，该参数必须被转交给主实例，
//! 否则用户双击快捷方式不会有任何反应（这正是修复前的实际表现）。
//!
//! 因此这里用命名管道承载二次实例的完整命令行意图，主实例监听线程读取后
//! 交给上层决定是「仅唤起设置页」还是「唤起并还原工作区」。

use std::sync::Mutex;
use std::sync::OnceLock;

#[cfg(target_os = "windows")]
use std::thread;

use tauri::AppHandle;

#[cfg(target_os = "windows")]
use crate::infrastructure::windows::common::ipc_channel::{
    send_startup_argument, StartupArgumentChannel,
};
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS, HANDLE, WAIT_OBJECT_0};
#[cfg(target_os = "windows")]
use windows::Win32::System::Threading::{CreateEventW, CreateMutexW, SetEvent, WaitForSingleObject};
#[cfg(target_os = "windows")]
use windows_core::{w, Owned};

#[cfg(target_os = "windows")]
const INSTANCE_MUTEX_NAME: windows_core::PCWSTR = w!("Local\\Dasktop.cn.syand.dasktop.Instance");
#[cfg(target_os = "windows")]
const SHOW_SETTINGS_EVENT_NAME: windows_core::PCWSTR =
    w!("Local\\Dasktop.cn.syand.dasktop.ShowSettings");
#[cfg(target_os = "windows")]
const STARTUP_ARGUMENT_PIPE_NAME: &str = r"\\.\pipe\Dasktop.cn.syand.dasktop.StartupArgument";

/// 二次启动携带工作区参数时广播的事件名，与前端 `shared/ipc/workspace.ts` 保持一致。
#[cfg(target_os = "windows")]
const STARTUP_WORKSPACE_EVENT: &str = "dasktop://startup-workspace-requested";

/// 主实例最近一次接收到的启动参数，供前端在唤起后查询。
///
/// 用 `take` 而不是读取，保证同一次唤起只会被消费一次，
/// 避免前端重复挂载时反复触发同一个工作区。
static PENDING_STARTUP_ARGUMENT: OnceLock<Mutex<Option<String>>> = OnceLock::new();

/// 单实例锁需要在 Tauri 运行期内持续持有，否则 Windows 命名互斥量会被自动释放。
#[cfg(target_os = "windows")]
pub(crate) struct SingleInstanceGuard {
    _mutex: OwnedKernelHandle,
    _show_settings_event: OwnedKernelHandle,
}

/// 非 Windows 平台暂不提供进程级单实例锁，保持调用方跨平台编译路径稳定。
#[cfg(not(target_os = "windows"))]
pub(crate) struct SingleInstanceGuard;

/// 获取当前用户会话内的 Dasktop 单实例锁。
///
/// 已有主实例时，把本次命令行参数通过管道转交过去并通知它显示设置窗口，
/// 然后返回 `None` 让当前进程退出。
#[cfg(target_os = "windows")]
pub(crate) fn acquire_or_notify_existing() -> Result<Option<SingleInstanceGuard>, String> {
    let mutex = unsafe { CreateMutexW(None, true, INSTANCE_MUTEX_NAME) }
        .map_err(|error| format!("无法创建 Dasktop 单实例锁：{error}"))?;
    let mutex_status = unsafe { GetLastError() };
    let mutex = unsafe { OwnedKernelHandle::new(mutex) };

    if mutex_status == ERROR_ALREADY_EXISTS {
        // 先把命令行交给主实例；成功即说明主实例的监听通道可用。
        let argument_forwarded =
            send_startup_argument(STARTUP_ARGUMENT_PIPE_NAME, &collect_startup_argument())
                .unwrap_or(false);

        // 无论参数是否转交成功，都必须通知主实例并退出当前进程。
        //
        // 唯一例外是主实例正处于退出过程中：此时既写不进管道、事件也无人接收。
        // 但那种情况下继续启动新实例会与正在退出的进程竞争同一批窗口，
        // 反而更容易出问题，因此仍选择退出，让用户重新触发即可。
        if let Err(error) = notify_primary_instance_to_show_settings() {
            eprintln!("failed to notify primary instance: {error}");
        }

        if !argument_forwarded {
            eprintln!(
                "dasktop single instance pipe unavailable, workspace argument dropped for this launch"
            );
        }

        return Ok(None);
    }

    let show_settings_event = create_show_settings_event()?;
    Ok(Some(SingleInstanceGuard {
        _mutex: mutex,
        _show_settings_event: show_settings_event,
    }))
}

/// 非 Windows 平台直接允许继续启动，避免把 Windows 互斥量策略泄漏到其他平台。
#[cfg(not(target_os = "windows"))]
pub(crate) fn acquire_or_notify_existing() -> Result<Option<SingleInstanceGuard>, String> {
    Ok(Some(SingleInstanceGuard))
}

/// 主实例启动后创建监听线程，接收二次启动的参数与唤起请求。
///
/// 管道属于增强能力：创建失败时二次实例无法转交工作区参数，
/// 但应用本身仍应正常启动，因此失败只记录日志而不阻断 setup。
#[cfg(target_os = "windows")]
pub(crate) fn start_show_settings_listener(app_handle: AppHandle) -> Result<(), String> {
    let show_settings_event = create_show_settings_event()?;

    // 管道必须在监听线程启动前创建完成，否则二次实例可能在管道就绪前
    // 连接失败并被误判成「没有主实例」。
    let argument_channel = match StartupArgumentChannel::create(STARTUP_ARGUMENT_PIPE_NAME) {
        Ok(channel) => channel,
        Err(error) => {
            eprintln!("failed to create single instance argument pipe, workspace shortcut wake-up disabled: {error}");
            return Ok(());
        }
    };

    thread::Builder::new()
        .name("dasktop-single-instance-listener".to_string())
        .spawn(move || listen_for_second_instance(argument_channel, show_settings_event, app_handle))
        .map(|_| ())
        .map_err(|error| format!("无法启动 Dasktop 单实例监听线程：{error}"))
}

/// 非 Windows 平台不启动监听线程，接口保留给主流程统一调用。
#[cfg(not(target_os = "windows"))]
pub(crate) fn start_show_settings_listener(_app_handle: tauri::AppHandle) -> Result<(), String> {
    Ok(())
}

/// 取出并清空待处理的启动参数。
///
/// 前端在工作区面板挂载时调用；返回 `None` 表示本次是普通启动，
/// 或参数已被先前的一次挂载消费掉。
pub(crate) fn take_pending_startup_argument() -> Option<String> {
    let store = PENDING_STARTUP_ARGUMENT.get_or_init(|| Mutex::new(None));
    let mut guard = match store.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };

    guard.take()
}

/// 从当前进程命令行提取需要转交给主实例的参数。
///
/// 只保留 `--workspace <id>` 这一对参数：其他内容（可执行文件路径等）
/// 对主实例没有意义，传递原始 argv 反而会污染解析。
#[cfg(target_os = "windows")]
fn collect_startup_argument() -> String {
    let arguments = std::env::args().collect::<Vec<_>>();

    match arguments.iter().position(|argument| argument == "--workspace") {
        Some(index) => match arguments.get(index + 1) {
            Some(workspace_id) if !workspace_id.trim().is_empty() => {
                format!("--workspace {}", workspace_id.trim())
            }
            _ => String::new(),
        },
        None => String::new(),
    }
}

/// 监听线程主循环。
///
/// `StartupArgumentChannel::receive` 会阻塞在 `ConnectNamedPipe` 上，
/// 因此二次实例的唤醒不需要额外轮询开销；事件句柄只在参数缺失时
/// 兜底判断是否存在「仅唤起」请求（例如用户重复点击托盘图标）。
#[cfg(target_os = "windows")]
fn listen_for_second_instance(
    argument_channel: StartupArgumentChannel,
    show_settings_event: OwnedKernelHandle,
    app_handle: AppHandle,
) {
    loop {
        // 收到 None 说明管道已损坏，监听无法继续，交由调用方结束线程。
        let Some(payload) = argument_channel.receive() else {
            eprintln!("dasktop single instance channel closed, listener stopped");
            break;
        };

        let has_payload = !payload.is_empty();
        if has_payload {
            store_pending_startup_argument(&payload);
            // 主实例的前端可能早已挂载完成，仅靠挂载时查询参数无法感知这次唤醒，
            // 因此额外广播一次事件让前端的监听器立刻触发还原。
            broadcast_startup_workspace_request(&app_handle, &payload);
        }

        // 事件已被置位说明确实有一次二次启动；即便参数为空也要唤起设置页，
        // 这样用户重复点击快捷方式时至少能看到界面响应。
        let event_signaled =
            unsafe { WaitForSingleObject(show_settings_event.get(), 0) } == WAIT_OBJECT_0;

        if !has_payload && !event_signaled {
            continue;
        }

        let app_handle_for_main_thread = app_handle.clone();
        if let Err(error) = app_handle.run_on_main_thread(move || {
            crate::infrastructure::tauri::tray::show_settings_window(&app_handle_for_main_thread);
        }) {
            eprintln!("failed to dispatch single-instance settings request: {error}");
            break;
        }
    }
}

/// 记录待处理的启动参数并唤醒前端。
#[cfg(target_os = "windows")]
fn store_pending_startup_argument(payload: &str) {
    let store = PENDING_STARTUP_ARGUMENT.get_or_init(|| Mutex::new(None));
    match store.lock() {
        Ok(mut guard) => *guard = Some(payload.to_owned()),
        Err(poisoned) => *poisoned.into_inner() = Some(payload.to_owned()),
    }
}

/// 把工作区 ID 通过 Tauri 事件推送给前端监听器。
///
/// 解析失败（例如参数格式不含工作区 ID）时静默跳过，
/// 此时监听线程仍会走「仅唤起设置页」的正常路径。
#[cfg(target_os = "windows")]
fn broadcast_startup_workspace_request(app_handle: &AppHandle, payload: &str) {
    use tauri::Emitter;

    let Some(workspace_id) = parse_workspace_id_from_payload(payload) else {
        return;
    };

    if let Err(error) = app_handle.emit(STARTUP_WORKSPACE_EVENT, workspace_id) {
        eprintln!("failed to emit startup workspace request: {error}");
    }
}

/// 从转交过来的参数串中提取工作区 ID。
#[cfg(target_os = "windows")]
fn parse_workspace_id_from_payload(payload: &str) -> Option<String> {
    let tokens = payload.split_whitespace().collect::<Vec<_>>();

    tokens
        .iter()
        .position(|token| *token == "--workspace")
        .and_then(|index| tokens.get(index + 1))
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_owned())
}

#[cfg(target_os = "windows")]
fn notify_primary_instance_to_show_settings() -> Result<(), String> {
    let event = create_show_settings_event()?;

    unsafe { SetEvent(event.get()) }.map_err(|error| format!("无法通知已运行的 Dasktop：{error}"))
}

#[cfg(target_os = "windows")]
fn create_show_settings_event() -> Result<OwnedKernelHandle, String> {
    let event = unsafe { CreateEventW(None, false, false, SHOW_SETTINGS_EVENT_NAME) }
        .map_err(|error| format!("无法创建 Dasktop 二次启动通知事件：{error}"))?;

    Ok(unsafe { OwnedKernelHandle::new(event) })
}

/// Win32 内核句柄可在线程间转移所有权；这里用小包装集中说明 unsafe 边界。
#[cfg(target_os = "windows")]
struct OwnedKernelHandle {
    handle: Owned<HANDLE>,
}

#[cfg(target_os = "windows")]
impl OwnedKernelHandle {
    /// 接管 Win32 API 返回的拥有型 HANDLE，释放逻辑交给 windows-core 的 Owned。
    unsafe fn new(handle: HANDLE) -> Self {
        Self {
            handle: Owned::new(handle),
        }
    }

    /// 等待和置位事件只需要临时借用原始句柄，调用方不能关闭它。
    fn get(&self) -> HANDLE {
        *self.handle
    }
}

// SAFETY: 该包装始终独占一个内核 HANDLE，跨线程移动后仍只由拥有者在 Drop 时关闭。
#[cfg(target_os = "windows")]
unsafe impl Send for OwnedKernelHandle {}

// SAFETY: 等待、置位和关闭 HANDLE 都由操作系统同步；共享引用不会暴露 Rust 可变状态。
#[cfg(target_os = "windows")]
unsafe impl Sync for OwnedKernelHandle {}
