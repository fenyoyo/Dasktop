//! Windows 剪贴板会话与底层写入工具，供文件剪贴板与文本剪贴板复用。

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{HANDLE, HGLOBAL};
#[cfg(target_os = "windows")]
use windows::Win32::System::DataExchange::{
    CloseClipboard, OpenClipboard, SetClipboardData,
};

#[cfg(target_os = "windows")]
use crate::infrastructure::windows::common::global_memory;

/// 打开系统剪贴板后用 Drop 自动关闭，防止异常返回时占住剪贴板。
#[cfg(target_os = "windows")]
pub(crate) struct ClipboardSession;

#[cfg(target_os = "windows")]
impl ClipboardSession {
    /// 打开系统剪贴板。
    pub(crate) fn open() -> Result<Self, String> {
        unsafe {
            OpenClipboard(None).map_err(|error| format!("无法打开系统剪贴板：{error}"))?;
        }

        Ok(Self)
    }
}

#[cfg(target_os = "windows")]
impl Drop for ClipboardSession {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseClipboard();
        }
    }
}

/// 剪贴板成功接管 HGLOBAL 后不能再手动释放；失败时必须释放，避免持续复制造成内存泄漏。
#[cfg(target_os = "windows")]
pub(crate) fn set_clipboard_hglobal(
    format: u32,
    memory: HGLOBAL,
    error_message: &str,
) -> Result<(), String> {
    let result = unsafe { SetClipboardData(format, Some(HANDLE(memory.0))) };
    if let Err(error) = result {
        unsafe {
            global_memory::free_if_unclaimed(memory);
        }
        return Err(format!("{error_message}：{error}"));
    }

    Ok(())
}
