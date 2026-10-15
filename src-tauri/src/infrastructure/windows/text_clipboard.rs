//! Windows 文本剪贴板封装，负责 CF_UNICODETEXT 文本的读取与写入。
//!
//! 与 `shell_clipboard.rs` 分工：后者处理文件路径列表（CF_HDROP），这里只处理
//! 纯文本（CF_UNICODETEXT）。两者共享 `common::clipboard` 的会话与内存工具。

#[cfg(target_os = "windows")]
use crate::infrastructure::windows::common::clipboard::{set_clipboard_hglobal, ClipboardSession};
#[cfg(target_os = "windows")]
use crate::infrastructure::windows::common::{global_memory, wide};

/// 将文本写入系统剪贴板（覆盖现有内容）。
///
/// 空文本直接返回成功，避免为空内容执行无意义的清空-写入循环。
#[cfg(target_os = "windows")]
pub(crate) fn write_text(text: &str) -> Result<(), String> {
    if text.is_empty() {
        return Ok(());
    }

    let _clipboard = ClipboardSession::open()?;
    unsafe {
        EmptyClipboard().map_err(|error| format!("无法清空系统剪贴板：{error}"))?;
    }

    let wide = wide::null_terminated(text);
    let bytes = unsafe {
        std::slice::from_raw_parts(wide.as_ptr().cast::<u8>(), wide.len() * std::mem::size_of::<u16>())
    };

    let memory = global_memory::create_moveable_from_bytes(bytes, "无法创建文本剪贴板内存")?;
    set_clipboard_hglobal(
        u32::from(CF_UNICODETEXT.0),
        memory,
        "无法写入文本剪贴板",
    )
}

/// 读取系统剪贴板文本；剪贴板没有文本格式时返回 None。
#[cfg(target_os = "windows")]
pub(crate) fn read_text() -> Result<Option<String>, String> {
    let _clipboard = ClipboardSession::open()?;
    if unsafe { IsClipboardFormatAvailable(u32::from(CF_UNICODETEXT.0)) }.is_err() {
        return Ok(None);
    }

    let handle = unsafe { GetClipboardData(u32::from(CF_UNICODETEXT.0)) }
        .map_err(|error| format!("无法读取文本剪贴板：{error}"))?;
    if handle.is_invalid() {
        return Ok(None);
    }

    let hglobal = HGLOBAL(handle.0);
    let size = unsafe { GlobalSize(hglobal) };
    if size == 0 {
        return Ok(None);
    }

    let pointer = unsafe { GlobalLock(hglobal) }.cast::<u16>();
    if pointer.is_null() {
        return Ok(None);
    }

    // 以 GlobalSize 为硬边界扫描到首个 0，防止剪贴板数据没有零结尾时越界读取。
    let slice = unsafe { std::slice::from_raw_parts(pointer, size / std::mem::size_of::<u16>()) };
    let text_len = slice.iter().position(|&c| c == 0).unwrap_or(slice.len());

    let text = String::from_utf16(&slice[..text_len])
        .map_err(|error| format!("剪贴板文本不是有效的 UTF-16：{error}"))?;

    unsafe {
        let _ = GlobalUnlock(hglobal);
    }

    Ok(Some(text))
}

/// 非 Windows 平台没有 CF_UNICODETEXT 语义，保持显式错误便于开发时定位平台差异。
#[cfg(not(target_os = "windows"))]
pub(crate) fn write_text(_text: &str) -> Result<(), String> {
    Err("当前平台暂不支持 Windows 文本剪贴板".to_string())
}

/// 非 Windows 平台读取时安静返回空，避免开发环境误触。
#[cfg(not(target_os = "windows"))]
pub(crate) fn read_text() -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::HGLOBAL;
#[cfg(target_os = "windows")]
use windows::Win32::System::DataExchange::{
    EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable,
};
#[cfg(target_os = "windows")]
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
#[cfg(target_os = "windows")]
use windows::Win32::System::Ole::CF_UNICODETEXT;
