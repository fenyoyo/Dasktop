//! 插件窗口尺寸的取值与持久化。
//!
//! 一个插件窗口最后有多大，是三个来源按优先级收敛出来的结果：
//!
//! 1. **插件级记录**（`plugin_window_sizes` 表）——用户在设置页给这个插件配过，
//!    或者他自己拖过这个窗口（关闭时写回，见 [`attach_size_persistence`]）；
//! 2. **清单声明**（`plugin.json` 的 `window` 字段）——插件作者的建议值；
//! 3. **全局默认**（`app_settings` 表的 `pluginWindowWidth` / `pluginWindowHeight`）——
//!    兜底，同时也是用户在设置页唯一能一改改全部的地方。
//!
//! 顺序里最容易被写反的是后两条：全局默认值**始终有值**（默认是 560×640），如果让它盖在
//! 清单声明之上，作者声明的尺寸就永远不生效，而且现象是「宿主坏了」而不是「配错了」，
//! 排查时很难想到这里。所以清单声明必须排在全局默认之前。
//!
//! # 为什么这里是唯一实现处
//!
//! 尺寸规则只在 Rust 侧实现一次，前端拿到的已经是算好的结果（随扫描结果下发的
//! [`PluginWindowSizeView`]）。两级各自实现时，「面板显示 800×600、开窗却是 560×640」
//! 这类偏差两侧都不报错，只能靠人工比对常量发现。
//!
//! # 为什么读不到时不算错误
//!
//! 读数据库失败（前端还没连库、表还没建、记录被删）一律回落到下一级，不向上抛错：
//! 窗口尺寸是一条锦上添花的偏好，没读到应当用默认值把窗口开出来，而不是让用户对着
//! 「打开失败」找不出原因。

use sqlx::{Row, SqlitePool};
use tauri::{AppHandle, Manager};

use crate::domain::app::settings;
use crate::domain::plugin::{
    PluginManifest, PluginWindowKind, PluginWindowSize, PluginWindowSizeSource, PluginWindowSizeView,
    PLUGIN_WINDOW_LABEL_PREFIX,
};
use crate::domain::plugin::contract::{
    PLUGIN_QUICK_WINDOW_MIN_SIZE, PLUGIN_QUICK_WINDOW_SIZE, PLUGIN_WINDOW_MAX_SIZE,
};
use crate::infrastructure::database;

const PLUGIN_ID_COLUMN: &str = "plugin_id";
const WIDTH_COLUMN: &str = "width";
const HEIGHT_COLUMN: &str = "height";
const UPDATED_AT_COLUMN: &str = "updated_at";
const KEY_COLUMN: &str = "key";
const VALUE_COLUMN: &str = "value";

/// 解析插件窗口打开时应采用的尺寸，并说明这个尺寸来自哪一级。
///
/// 三个来源都可能只为某一维给出值（清单允许只写 width，全局设置也可能只改过一项），
/// 因此每一维独立回落，最后一次 [`PluginWindowSize::clamped`] 统一收口。
pub async fn resolve_window_size(
    app: &AppHandle,
    plugin_id: &str,
    manifest: Option<&PluginManifest>,
) -> PluginWindowSizeView {
    if let Some(stored) = read_plugin_window_size(app, plugin_id).await {
        return PluginWindowSizeView::new(stored, PluginWindowSizeSource::Custom);
    }

    let declared = manifest.and_then(|manifest| manifest.window).unwrap_or_default();
    let is_quick = declared.kind == Some(PluginWindowKind::Quick);

    // quick 窗口有独立尺寸区间（更小、下限更高），否则沿用全局默认尺寸。
    let fallback = if is_quick {
        PluginWindowSize::from_tuple(PLUGIN_QUICK_WINDOW_SIZE)
    } else {
        read_default_window_size(app)
            .await
            .unwrap_or_else(PluginWindowSize::default_size)
    };

    let source = if declared.width.is_some() || declared.height.is_some() {
        PluginWindowSizeSource::Declared
    } else {
        PluginWindowSizeSource::Global
    };

    // quick 窗口用更高的下限夹取；其尺寸区间与标准窗口不同，不能用全局下限糊弄。
    let size = if is_quick {
        PluginWindowSize::clamped_between(
            declared.width.unwrap_or(fallback.width),
            declared.height.unwrap_or(fallback.height),
            PluginWindowSize::from_tuple(PLUGIN_QUICK_WINDOW_MIN_SIZE),
            PluginWindowSize::from_tuple(PLUGIN_WINDOW_MAX_SIZE),
        )
    } else {
        PluginWindowSize::clamped(
            declared.width.unwrap_or(fallback.width),
            declared.height.unwrap_or(fallback.height),
        )
    };

    PluginWindowSizeView::new(size, source)
}

/// 记住单个插件的窗口尺寸，单位为逻辑像素。
///
/// 取值先过一遍夹取：调用方给的是窗口当时的物理像素除以缩放率，浮点误差在所难免，
/// 而写库前统一收敛能保证库里不会出现超出边界的值。
pub async fn save_window_size(
    app: &AppHandle,
    plugin_id: &str,
    width: f64,
    height: f64,
) -> Result<(), String> {
    // 前端尚未连库时（宿主刚启动，设置窗还没来得及初始化存储）返回 Ok：
    // 这一次窗口用默认尺寸开出来就够了，下一次就能读到用户的设置。
    let Some(pool) = database::resolve_app_sqlite_pool(app).await? else {
        return Ok(());
    };

    ensure_window_size_storage(&pool).await?;

    let size = PluginWindowSize::clamped(width, height);
    let table_name = settings::tables::PLUGIN_WINDOW_SIZES;
    let query = format!(
        "
        INSERT INTO {table_name} ({PLUGIN_ID_COLUMN}, {WIDTH_COLUMN}, {HEIGHT_COLUMN}, {UPDATED_AT_COLUMN})
        VALUES (?, ?, ?, ?)
        ON CONFLICT({PLUGIN_ID_COLUMN}) DO UPDATE SET
          {WIDTH_COLUMN} = excluded.{WIDTH_COLUMN},
          {HEIGHT_COLUMN} = excluded.{HEIGHT_COLUMN},
          {UPDATED_AT_COLUMN} = excluded.{UPDATED_AT_COLUMN}
        "
    );

    sqlx::query(&query)
        .bind(plugin_id)
        .bind(size.width)
        .bind(size.height)
        .bind(current_timestamp_millis())
        .execute(&pool)
        .await
        .map_err(|error| format!("保存插件窗口尺寸失败：{error}"))?;

    Ok(())
}

/// 在插件窗口关闭时把它的最后尺寸写回持久化。
///
/// 挂在 `CloseRequested` 而不是 `Destroyed`：后者触发时窗口资源已经开始回收，再问尺寸
/// 拿到的不是用户看到的那个值。代价是「关闭被取消」的场景读不到——那种逻辑宿主目前没有，
/// 出现时这里读到的仍是最后一次可用尺寸，不影响结果。
///
/// 写回刻意穿 [`tauri::async_runtime::spawn`]：事件回调跑在窗口线程上，而保存要访问
/// SQLite 连接池，直接在回调里 await 会把「关窗口」这个动作拖到一次磁盘写入之后。
pub fn attach_size_persistence(window: &tauri::WebviewWindow) {
    let Some(plugin_id) = resolve_plugin_id_from_label(window.label()) else {
        return;
    };

    // 注册用的句柄与闭包捕获的句柄必须是两个：方法调用要在接收者上持一次借用，
    // 而闭包又得把窗口 move 进去，同一个变量同时借用又移动是编译不过的。
    let callback_window = window.clone();

    window.on_window_event(move |event| {
        if !matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
            return;
        }

        // 最大化时 inner_size 是整块屏幕，记住它等于下次开窗直接铺满，
        // 而这并不是用户「调整出来的尺寸」。
        if callback_window.is_maximized().unwrap_or(false) {
            return;
        }

        let Ok(size) = callback_window.inner_size() else {
            return;
        };

        let scale_factor = callback_window.scale_factor().unwrap_or(1.0).max(1.0);
        let width = size.width as f64 / scale_factor;
        let height = size.height as f64 / scale_factor;
        let app_handle = callback_window.app_handle().clone();
        let plugin_id = plugin_id.clone();

        tauri::async_runtime::spawn(async move {
            // 应用正在退出时连接池可能已经不可用，此时失败无妨：尺寸只是偏好，
            // 下一次开窗会回落到全局默认值。这里刻意留下日志而不是静默——
            // 「改了设置没生效」这类反馈需要一条能追的线索。
            if let Err(error) = save_window_size(&app_handle, &plugin_id, width, height).await {
                eprintln!("[plugin] 保存插件 {plugin_id} 窗口尺寸失败：{error}");
            }
        });
    });
}

/// 读取该插件单独记住的窗口尺寸。
///
/// 任何一步失败都返回 `None`：记录不存在、表还没建、连接池拿不到，三种情况对调用方
/// 都是同一件事——「这个插件没有记住尺寸」，继续往下走更高级别即可。
async fn read_plugin_window_size(app: &AppHandle, plugin_id: &str) -> Option<PluginWindowSize> {
    let pool = database::resolve_app_sqlite_pool(app).await.ok()??;

    let table_name = settings::tables::PLUGIN_WINDOW_SIZES;
    let query = format!(
        "
        SELECT {WIDTH_COLUMN}, {HEIGHT_COLUMN}
        FROM {table_name}
        WHERE {PLUGIN_ID_COLUMN} = ?
        "
    );
    let row = sqlx::query(&query)
        .bind(plugin_id)
        .fetch_optional(&pool)
        .await
        .ok()??;

    Some(PluginWindowSize::clamped(
        row.try_get::<f64, _>(WIDTH_COLUMN).ok()?,
        row.try_get::<f64, _>(HEIGHT_COLUMN).ok()?,
    ))
}

/// 读取全局默认的插件窗口尺寸。
///
/// 只有宽高都读到才算「配好了」：单独一项有效说明数据库里的记录被改过，此时继续用
/// 内置默认值比拼出一个半新半旧的尺寸更容易解释。
async fn read_default_window_size(app: &AppHandle) -> Option<PluginWindowSize> {
    let pool = database::resolve_app_sqlite_pool(app).await.ok()??;

    Some(PluginWindowSize::clamped(
        read_number_setting(&pool, settings::keys::PLUGIN_WINDOW_WIDTH).await?,
        read_number_setting(&pool, settings::keys::PLUGIN_WINDOW_HEIGHT).await?,
    ))
}

/// 读取 `app_settings` 里的一项数值设置。
///
/// 值由前端以 `JSON.stringify(number)` 写入（见 `shared/storage/database.ts` 的
/// `saveSetting`），因此这里按 JSON 解析而不是直接当成数字读：`"560"` 和 `560` 都能
/// 正确解出，也顺带躲开了 SQLite 里 INTEGER / REAL 的表示差异。
async fn read_number_setting(pool: &SqlitePool, key: &str) -> Option<f64> {
    let table_name = settings::APP_SETTINGS_TABLE;
    let query = format!("SELECT {VALUE_COLUMN} FROM {table_name} WHERE {KEY_COLUMN} = ?");
    let row = sqlx::query(&query)
        .bind(key)
        .fetch_optional(pool)
        .await
        .ok()??;

    let raw = row.try_get::<String, _>(VALUE_COLUMN).ok()?;

    serde_json::from_str::<f64>(&raw).ok()
}

/// 确保插件窗口尺寸表存在。
///
/// 与前端 `shared/storage/database.ts` 的 `ensurePluginWindowSizeStorage` 是同一张表，
/// 两端都保留了建表语句：窗口关闭时的写回可能发生在设置窗尚未初始化存储的时刻
/// （例如插件详情页被单独唤起），只依赖前端建表会让那次写回失败。
async fn ensure_window_size_storage(pool: &SqlitePool) -> Result<(), String> {
    let table_name = settings::tables::PLUGIN_WINDOW_SIZES;
    let query = format!(
        "
        CREATE TABLE IF NOT EXISTS {table_name} (
          {PLUGIN_ID_COLUMN} TEXT PRIMARY KEY,
          {WIDTH_COLUMN} REAL NOT NULL,
          {HEIGHT_COLUMN} REAL NOT NULL,
          {UPDATED_AT_COLUMN} INTEGER NOT NULL
        )
        "
    );

    sqlx::query(&query)
        .execute(pool)
        .await
        .map_err(|error| format!("初始化插件窗口尺寸存储失败：{error}"))?;

    Ok(())
}

/// 从窗口标签反推插件 id；非插件窗口返回 `None`。
fn resolve_plugin_id_from_label(window_label: &str) -> Option<String> {
    let plugin_id = window_label.strip_prefix(PLUGIN_WINDOW_LABEL_PREFIX)?;

    Some(plugin_id.to_string())
}

/// 当前时间的毫秒时间戳。
///
/// 失败时退化为 0：`updated_at` 只用于同一主键上的先后判断，取不到真实时间不影响
/// 覆盖逻辑本身（同一插件 id 只有一行）。
fn current_timestamp_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}
