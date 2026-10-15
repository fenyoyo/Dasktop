//! 基础设施层封装文件系统、Windows Shell 和 Tauri 外设等不可替换的系统能力。

pub(crate) mod database;
pub(crate) mod filesystem;
pub(crate) mod http;
pub(crate) mod tauri;
pub(crate) mod windows;
