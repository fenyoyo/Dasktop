//! 领域层只保留跨命令共享的业务类型和契约常量，避免系统 API 细节泄漏到调用方。

pub mod app;
pub mod desktop;
pub mod filesystem;
pub mod plugin;
