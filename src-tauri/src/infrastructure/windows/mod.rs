//! Windows 平台能力统一收口，非 Windows 兜底实现也放在同名模块内保持调用方稳定。

pub(crate) mod common;
pub(crate) mod desktop_glue;
pub(crate) mod folder_dialog;
pub(crate) mod mouse;
pub(crate) mod native_drop;
pub(crate) mod shell_clipboard;
pub(crate) mod shell_context;
pub(crate) mod shell_desktop_icon;
pub(crate) mod shell_file;
pub(crate) mod shell_icon;
pub(crate) mod shell_virtual_item;
pub(crate) mod single_instance;
pub(crate) mod webview_runtime;
pub(crate) mod workspace;
