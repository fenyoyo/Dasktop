//! 插件运行日志基础设施。
//!
//! 每个插件单独一个日志文件：插件输出量不可控，混写进宿主日志会让宿主自身的排查线索
//! 被淹没；同时日志带容量上限，插件死循环刷日志时最多占满单文件配额。

use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::domain::plugin::PLUGIN_LOG_MAX_BYTES;

/// 向指定插件的日志文件追加一行记录。
///
/// `plugin_id` 进文件名之前必须已经过 id 白名单校验（由调用方保证），
/// 否则 `../` 形式的 id 会让日志写到插件目录之外。
pub fn append_log(log_dir: &Path, plugin_id: &str, level: &str, message: &str) -> Result<(), String> {
    std::fs::create_dir_all(log_dir)
        .map_err(|error| format!("无法创建插件日志目录 {}：{error}", log_dir.display()))?;

    let log_path = log_dir.join(format!("{plugin_id}.log"));
    reset_if_oversized(&log_path)?;

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| format!("插件日志不可写 {}：{error}", log_path.display()))?;

    // 时间戳使用毫秒级 epoch 而不是本地时间字符串：格式化本地时间需要额外的时区依赖，
    // 而插件日志主要用来对齐事件先后顺序，epoch 已经足够且不引入新的 crate。
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();

    writeln!(file, "[{timestamp}] [{level}] {message}")
        .map_err(|error| format!("插件日志写入失败：{error}"))
}

/// 日志文件超过上限时整体截断。
///
/// 选择「整体清空」而不是「保留尾部」：截断只是兜底保护，不值得为它维护追加位置的
/// 读写游标；清空后新日志从头开始，用户仍能拿到最近一段完整记录。
fn reset_if_oversized(log_path: &Path) -> Result<(), String> {
    let Ok(metadata) = std::fs::metadata(log_path) else {
        return Ok(());
    };

    if metadata.len() <= PLUGIN_LOG_MAX_BYTES {
        return Ok(());
    }

    std::fs::write(log_path, format!("[0] [host] 日志超过 {PLUGIN_LOG_MAX_BYTES} 字节，已重置\n"))
        .map_err(|error| format!("插件日志重置失败：{error}"))
}
