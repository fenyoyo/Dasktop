//! Windows 文件剪贴板封装，负责与 Explorer 兼容的 CF_HDROP 路径列表和 DropEffect 意图。

use std::path::PathBuf;

use crate::domain::desktop::FileClipboardOperation;

/// 从系统剪贴板读取到的文件路径和用户操作意图。
pub(crate) struct FileClipboardPayload {
    pub(crate) operation: FileClipboardOperation,
    pub(crate) paths: Vec<PathBuf>,
}

/// 将真实文件路径写入系统文件剪贴板，供 Box 或 Explorer 后续粘贴。
#[cfg(target_os = "windows")]
pub(crate) fn write_file_list(
    paths: &[PathBuf],
    operation: FileClipboardOperation,
) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }

    let _clipboard = ClipboardSession::open()?;
    unsafe {
        EmptyClipboard().map_err(|error| format!("无法清空系统剪贴板：{error}"))?;
    }

    let hdrop_memory = hdrop::create_file_list_memory(paths, "无法创建文件剪贴板路径内存")?;
    set_clipboard_hglobal(
        u32::from(CF_HDROP.0),
        hdrop_memory,
        "无法写入文件剪贴板路径列表",
    )?;

    let effect_memory = create_drop_effect_memory(operation)?;
    set_clipboard_hglobal(
        preferred_drop_effect_format()?,
        effect_memory,
        "无法写入文件剪贴板操作意图",
    )?;

    Ok(())
}

/// 读取系统文件剪贴板；没有文件列表时返回 None，避免 Ctrl+V 在空剪贴板时报错。
#[cfg(target_os = "windows")]
pub(crate) fn read_file_list() -> Result<Option<FileClipboardPayload>, String> {
    let _clipboard = ClipboardSession::open()?;
    if unsafe { IsClipboardFormatAvailable(u32::from(CF_HDROP.0)) }.is_err() {
        return Ok(None);
    }

    let handle = unsafe { GetClipboardData(u32::from(CF_HDROP.0)) }
        .map_err(|error| format!("无法读取文件剪贴板路径列表：{error}"))?;
    let hdrop = HDROP(handle.0);
    if hdrop.is_invalid() {
        return Ok(None);
    }

    let paths = hdrop::read_paths(hdrop);
    if paths.is_empty() {
        return Ok(None);
    }

    Ok(Some(FileClipboardPayload {
        operation: read_preferred_operation().unwrap_or(FileClipboardOperation::Copy),
        paths,
    }))
}

/// 非 Windows 平台没有 Explorer 文件剪贴板语义，保持显式错误便于开发时定位平台差异。
#[cfg(not(target_os = "windows"))]
pub(crate) fn write_file_list(
    _paths: &[PathBuf],
    _operation: FileClipboardOperation,
) -> Result<(), String> {
    Err("当前平台暂不支持 Windows 文件剪贴板".to_string())
}

/// 非 Windows 平台粘贴时安静返回空剪贴板，避免开发环境误触真实文件操作。
#[cfg(not(target_os = "windows"))]
pub(crate) fn read_file_list() -> Result<Option<FileClipboardPayload>, String> {
    Ok(None)
}

#[cfg(target_os = "windows")]
use std::mem::size_of;
#[cfg(target_os = "windows")]
use windows::core::w;
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::HGLOBAL;
#[cfg(target_os = "windows")]
use windows::Win32::System::DataExchange::{
    EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, RegisterClipboardFormatW,
};
#[cfg(target_os = "windows")]
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
#[cfg(target_os = "windows")]
use windows::Win32::System::Ole::{CF_HDROP, DROPEFFECT_COPY, DROPEFFECT_MOVE};
#[cfg(target_os = "windows")]
use windows::Win32::UI::Shell::HDROP;

#[cfg(target_os = "windows")]
use crate::infrastructure::windows::common::clipboard::set_clipboard_hglobal;
#[cfg(target_os = "windows")]
use crate::infrastructure::windows::common::{clipboard::ClipboardSession, global_memory, hdrop};

#[cfg(target_os = "windows")]
fn create_drop_effect_memory(operation: FileClipboardOperation) -> Result<HGLOBAL, String> {
    let effect = if operation.is_cut() {
        DROPEFFECT_MOVE.0
    } else {
        DROPEFFECT_COPY.0
    };

    global_memory::create_moveable_from_bytes(&effect.to_le_bytes(), "无法创建文件剪贴板操作内存")
}

#[cfg(target_os = "windows")]
fn read_preferred_operation() -> Option<FileClipboardOperation> {
    let format = preferred_drop_effect_format().ok()?;
    if unsafe { IsClipboardFormatAvailable(format) }.is_err() {
        return None;
    }

    let handle = unsafe { GetClipboardData(format) }.ok()?;
    let hglobal = HGLOBAL(handle.0);
    if hglobal.is_invalid() || unsafe { GlobalSize(hglobal) } < size_of::<u32>() {
        return None;
    }

    let pointer = unsafe { GlobalLock(hglobal) }.cast::<u32>();
    if pointer.is_null() {
        return None;
    }
    let effect = unsafe { *pointer };
    unsafe {
        let _ = GlobalUnlock(hglobal);
    }

    if effect & DROPEFFECT_MOVE.0 == DROPEFFECT_MOVE.0 {
        Some(FileClipboardOperation::Cut)
    } else {
        Some(FileClipboardOperation::Copy)
    }
}

#[cfg(target_os = "windows")]
fn preferred_drop_effect_format() -> Result<u32, String> {
    let format = unsafe { RegisterClipboardFormatW(w!("Preferred DropEffect")) };
    if format == 0 {
        return Err("无法注册文件剪贴板操作格式".to_string());
    }

    Ok(format)
}
