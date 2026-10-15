//! 应用退出前的系统桌面图标恢复流程，集中处理 SQLite 记录和 Windows 图标状态回写。

use crate::domain::app::settings;
use crate::infrastructure::database;
use crate::infrastructure::windows::shell_desktop_icon;
use sqlx::{Executor, Row, SqlitePool};
use tauri::AppHandle;

const SHELL_ID_COLUMN: &str = "shell_id";
const PREVIOUS_VISIBLE_COLUMN: &str = "previous_visible";
const MANAGED_HIDDEN_COLUMN: &str = "managed_hidden";
const UPDATED_AT_COLUMN: &str = "updated_at";

/// Dasktop 接管过的系统桌面图标状态，退出恢复时按首次接管前的状态还原 Windows 桌面。
struct ShellIconVisibilityRecord {
    managed_hidden: bool,
    previous_visible: bool,
    shell_id: String,
}

/// 应用正常退出前释放 Dasktop 对系统桌面图标的接管，让 Windows 桌面回到接管前状态。
pub fn restore_shell_desktop_icons_before_exit(app: &AppHandle) -> Result<(), String> {
    tauri::async_runtime::block_on(restore_shell_desktop_icons_before_exit_async(app))
}

async fn restore_shell_desktop_icons_before_exit_async(app: &AppHandle) -> Result<(), String> {
    let Some(pool) = database::resolve_app_sqlite_pool(app).await? else {
        return Ok(());
    };
    ensure_shell_icon_visibility_record_storage(&pool).await?;
    let records = load_shell_icon_visibility_records(&pool).await?;
    let mut errors = Vec::new();

    for record in records {
        if let Err(error) = restore_shell_icon_visibility_record(&pool, &record).await {
            errors.push(error);
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

async fn ensure_shell_icon_visibility_record_storage(pool: &SqlitePool) -> Result<(), String> {
    let table_name = settings::tables::SHELL_ICON_VISIBILITY_RECORDS;
    let query = format!(
        "
        CREATE TABLE IF NOT EXISTS {table_name} (
          {SHELL_ID_COLUMN} TEXT PRIMARY KEY,
          {PREVIOUS_VISIBLE_COLUMN} INTEGER NOT NULL,
          {MANAGED_HIDDEN_COLUMN} INTEGER NOT NULL,
          {UPDATED_AT_COLUMN} INTEGER NOT NULL
        )
        "
    );
    pool.execute(sqlx::query(&query))
        .await
        .map_err(|error| format!("初始化系统桌面图标接管记录失败：{error}"))?;

    Ok(())
}

async fn load_shell_icon_visibility_records(
    pool: &SqlitePool,
) -> Result<Vec<ShellIconVisibilityRecord>, String> {
    let table_name = settings::tables::SHELL_ICON_VISIBILITY_RECORDS;
    let query = format!(
        "
        SELECT {SHELL_ID_COLUMN}, {PREVIOUS_VISIBLE_COLUMN}, {MANAGED_HIDDEN_COLUMN}
        FROM {table_name}
        ORDER BY {UPDATED_AT_COLUMN} ASC
        "
    );
    let rows = sqlx::query(&query)
        .fetch_all(pool)
        .await
        .map_err(|error| format!("读取系统桌面图标接管记录失败：{error}"))?;

    rows.into_iter()
        .map(|row| {
            Ok(ShellIconVisibilityRecord {
                managed_hidden: read_sqlite_bool(&row, MANAGED_HIDDEN_COLUMN)?,
                previous_visible: read_sqlite_bool(&row, PREVIOUS_VISIBLE_COLUMN)?,
                shell_id: row
                    .try_get::<String, _>(SHELL_ID_COLUMN)
                    .map_err(|error| format!("读取系统桌面图标 ID 失败：{error}"))?,
            })
        })
        .collect()
}

async fn restore_shell_icon_visibility_record(
    pool: &SqlitePool,
    record: &ShellIconVisibilityRecord,
) -> Result<(), String> {
    if record.managed_hidden {
        shell_desktop_icon::set_shell_desktop_icon_visible(
            &record.shell_id,
            record.previous_visible,
        )?;
    }

    delete_shell_icon_visibility_record(pool, &record.shell_id).await
}

async fn delete_shell_icon_visibility_record(
    pool: &SqlitePool,
    shell_id: &str,
) -> Result<(), String> {
    let table_name = settings::tables::SHELL_ICON_VISIBILITY_RECORDS;
    let query = format!("DELETE FROM {table_name} WHERE {SHELL_ID_COLUMN} = ?");
    sqlx::query(&query)
        .bind(shell_id)
        .execute(pool)
        .await
        .map_err(|error| format!("清理系统桌面图标接管记录失败：{error}"))?;

    Ok(())
}

fn read_sqlite_bool(row: &sqlx::sqlite::SqliteRow, column_name: &str) -> Result<bool, String> {
    row.try_get::<i64, _>(column_name)
        .map(|value| value == 1)
        .map_err(|error| format!("读取系统桌面图标布尔状态失败：{error}"))
}
