//! 单实例启动参数通道。
//!
//! Windows 命名事件的载荷只有一个 bit，无法携带工作区 ID 这类启动参数。
//! 二次实例（例如双击工作区快捷方式）需要把自己的命令行意图传达给已运行的
//! 主实例，这里用命名管道承载参数本身。
//!
//! 设计要点：
//! - 管道使用消息模式，每次写入天然成为一条独立消息，读取方无需处理粘包。
//! - 主实例的监听线程以 `ConnectNamedPipe` 的调用作为等待原语，
//!   未连接时会阻塞在系统调用上，由断开连接自然驱动下一轮循环。
//! - 连接建立后立刻读取并断开，保证管道可以重复接受下一次唤醒。

use std::os::windows::ffi::OsStrExt;

use windows::core::PCWSTR;
use windows::Win32::Foundation::{
    CloseHandle, ERROR_PIPE_CONNECTED, HANDLE, INVALID_HANDLE_VALUE,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
    FILE_SHARE_READ, OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_MESSAGE,
    PIPE_TYPE_MESSAGE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT, WaitNamedPipeW,
};

/// 单条消息的缓冲区上限。
///
/// 当前载荷只是一个工作区 ID（数十字节），1KB 留足余量同时限制异常超长输入。
const PIPE_BUFFER_SIZE: u32 = 1024;

/// 二次实例等待主实例腾出管道的时间上限。
///
/// 主实例处理上一次唤醒时会短暂断开连接，该等待避免把「正忙」误判为「不存在」。
const PIPE_CLIENT_AVAILABLE_TIMEOUT_MS: u32 = 3000;

/// 命名管道服务端，主实例持有它等待二次实例写入启动参数。
pub(crate) struct StartupArgumentChannel {
    pipe_handle: HANDLE,
}

// SAFETY: 管道句柄由本结构独占拥有，跨线程移动后仍只由同一所有者关闭；
// Win32 保证同一管道句柄上的并发命名管道调用是安全的。
unsafe impl Send for StartupArgumentChannel {}

impl StartupArgumentChannel {
    /// 创建管道服务端实例。
    pub(crate) fn create(pipe_name: &str) -> Result<Self, String> {
        let pipe_name_wide = to_wide(pipe_name);

        // SAFETY: pipe_name_wide 在调用期间保持存活且零结尾；
        // dwOpenMode 只接受 PIPE_ACCESS_* 与 FILE_FLAG_* 标志的组合，
        // 传 GENERIC_READ/GENERIC_WRITE 这类访问掩码会导致创建失败。
        // 超时参数设为 0 表示不限制单个客户端的连接间隔，等待策略由调用方控制。
        let pipe_handle = unsafe {
            CreateNamedPipeW(
                PCWSTR(pipe_name_wide.as_ptr()),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT,
                PIPE_UNLIMITED_INSTANCES,
                PIPE_BUFFER_SIZE,
                PIPE_BUFFER_SIZE,
                0,
                None,
            )
        };

        if pipe_handle == INVALID_HANDLE_VALUE {
            return Err("无法创建单实例启动参数管道".to_owned());
        }

        Ok(Self { pipe_handle })
    }

    /// 阻塞等待一次客户端连接，成功时读取其写入的启动参数。
    ///
    /// 返回值语义：
    /// - `None` —— 管道被中断（例如服务端关闭），调用方应结束监听循环；
    /// - `Some(空串)` —— 客户端接入但未携带参数，语义为「仅唤起设置页」；
    /// - `Some(参数)` —— 二次实例传达了启动参数。
    pub(crate) fn receive(&self) -> Option<String> {
        // SAFETY: pipe_handle 由本结构独占拥有，调用期间保持有效。
        let connect_result = unsafe { ConnectNamedPipe(self.pipe_handle, None) };

        // ERROR_PIPE_CONNECTED 表示客户端在上次断开前就已连上，
        // 属于正常情况而非错误，需要继续读取。
        if let Err(error) = connect_result {
            if error.code().0 as u32 != ERROR_PIPE_CONNECTED.0 {
                return None;
            }
        }

        let payload = self.read_message();

        // SAFETY: 断开后管道可再次接受新连接，句柄本身保持有效。
        unsafe {
            let _ = DisconnectNamedPipe(self.pipe_handle);
        }

        Some(payload)
    }

    /// 读取管道中的单条消息，失败时返回空字符串。
    fn read_message(&self) -> String {
        let mut buffer = vec![0u8; PIPE_BUFFER_SIZE as usize];
        let mut bytes_read = 0u32;

        // SAFETY: buffer 在调用期间保持存活，bytes_read 是合法出参指针。
        let read_result = unsafe {
            ReadFile(
                self.pipe_handle,
                Some(&mut buffer),
                Some(&mut bytes_read),
                None,
            )
        };

        if read_result.is_err() || bytes_read == 0 {
            return String::new();
        }

        String::from_utf8_lossy(&buffer[..bytes_read as usize])
            .trim()
            .to_owned()
    }
}

impl Drop for StartupArgumentChannel {
    fn drop(&mut self) {
        // SAFETY: 句柄由本结构独占拥有，Drop 只执行一次。
        unsafe {
            let _ = CloseHandle(self.pipe_handle);
        }
    }
}

/// 把启动参数发送给已运行的主实例。
///
/// 返回 `Ok(true)` 表示主实例已收到；`Ok(false)` 表示没有主实例在监听，
/// 调用方应当按正常流程启动而不是退出。
pub(crate) fn send_startup_argument(pipe_name: &str, payload: &str) -> Result<bool, String> {
    let pipe_name_wide = to_wide(pipe_name);

    // 主实例正在处理上一次唤醒时管道会短暂无可用实例，
    // 这里先等待它腾出来，避免把「忙」误判成「不存在」。
    let _ = unsafe {
        WaitNamedPipeW(
            PCWSTR(pipe_name_wide.as_ptr()),
            PIPE_CLIENT_AVAILABLE_TIMEOUT_MS,
        )
    };

    // SAFETY: pipe_name_wide 在调用期间保持存活且零结尾。
    let pipe_handle = unsafe {
        CreateFileW(
            PCWSTR(pipe_name_wide.as_ptr()),
            FILE_GENERIC_READ.0 | FILE_GENERIC_WRITE.0,
            FILE_SHARE_READ,
            None,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            None,
        )
    };

    let Ok(pipe_handle) = pipe_handle else {
        // 打不开管道说明没有主实例，交由调用方决定是否自任主实例。
        return Ok(false);
    };

    let bytes = payload.as_bytes();
    let mut bytes_written = 0u32;

    // SAFETY: bytes 在调用期间保持存活，bytes_written 是合法出参指针。
    let write_result = unsafe {
        WriteFile(
            pipe_handle,
            Some(bytes),
            Some(&mut bytes_written),
            None,
        )
    };

    // SAFETY: pipe_handle 由本函数独占拥有，写入后立即关闭。
    unsafe {
        let _ = CloseHandle(pipe_handle);
    }

    write_result.map_err(|error| format!("向主实例传递启动参数失败: {error}"))?;

    Ok(bytes_written as usize == bytes.len())
}

/// 将字符串转成 Windows API 需要的 UTF-16 零结尾缓冲区。
fn to_wide(value: &str) -> Vec<u16> {
    std::ffi::OsStr::new(value)
        .encode_wide()
        .chain(Some(0))
        .collect()
}
