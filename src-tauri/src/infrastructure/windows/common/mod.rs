//! Windows 底层通用工具，供 Shell、拖放、剪贴板等适配器复用。

#[cfg(target_os = "windows")]
pub(crate) mod bitmap;
#[cfg(target_os = "windows")]
pub(crate) mod clipboard;
#[cfg(target_os = "windows")]
pub(crate) mod com;
pub(crate) mod desktop_path;
pub(crate) mod error;
pub(crate) mod global_memory;
#[cfg(target_os = "windows")]
pub(crate) mod hdrop;
#[cfg(target_os = "windows")]
pub(crate) mod ipc_channel;
pub(crate) mod png;
#[cfg(target_os = "windows")]
pub(crate) mod screen_capture;
pub(crate) mod wide;
