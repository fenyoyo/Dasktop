//! Tauri 命令层只负责 IPC 参数接收、窗口句柄提取和服务调用，业务规则下沉到 services。

pub mod app;
pub mod box_folder;
pub mod desktop;
pub mod native_drop;
pub mod workspace;
