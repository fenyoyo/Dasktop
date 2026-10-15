//! 应用主数据库的连接池获取。
//!
//! 数据库由**前端**通过 `tauri-plugin-sql` 打开（`Database.load`），Rust 侧不负责连接，
//! 只在已有连接上复用同一个连接池。这个方向与直觉相反，原因很直接：连接池是
//! `tauri-plugin-sql` 托管的状态，Rust 侧再开一个连接会连到同一份 SQLite 文件上，
//! 两边各自持有写锁，写冲突只会以「database is locked」的形式在运行期冒出来。
//!
//! 因此这里只做一件事：把「怎么从 AppHandle 找到那个连接池」收在一处，
//! 调用方不必各自 `state::<DbInstances>()` 再把枚举匹配一遍。

use sqlx::SqlitePool;
use tauri::{AppHandle, Manager};
use tauri_plugin_sql::{DbInstances, DbPool};

use crate::domain::app::settings;

/// 取应用主数据库的 SQLite 连接池。
///
/// **前端尚未建立连接时返回 `Ok(None)` 而不是错误**：这是宿主启动过程中的正常中间态。
/// 举例来说，插件窗口可以在设置窗还没来得及连库时就被打开，而此时「读不到窗口尺寸
/// 设置」应当回落默认值，不该让开窗口这件事失败——连接晚一点建立，用户最多是用默认
/// 尺寸开一次窗。
pub async fn resolve_app_sqlite_pool(app: &AppHandle) -> Result<Option<SqlitePool>, String> {
    let db_instances = app.state::<DbInstances>();
    let instances = db_instances.0.read().await;
    let Some(db_pool) = instances.get(settings::APP_DATABASE_URL) else {
        return Ok(None);
    };

    // 应用只声明了 sqlite 一种驱动（见 Cargo.toml 的 `tauri-plugin-sql` 特性），
    // 其它分支在生产配置下不可达，按其余凭据以外的取值直接返回更诚实的 None。
    let DbPool::Sqlite(pool) = db_pool;

    Ok(Some(pool.clone()))
}
