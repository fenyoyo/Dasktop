//! 应用级全局快捷键：把「系统当前前台窗口」切换为置顶 / 取消置顶。
//!
//! 这是宿主唯一一条不属于插件域的全局快捷键。用户在设置页配一个组合键，按下后作用于
//! **任意应用**的前台窗口，等价于 PowerToys 的 Always on Top。
//!
//! # 本模块是全局快捷键注册的唯一编排处
//!
//! 系统里同一时刻只能存在一批注册结果，而「改键后旧键必须注销」这条约束意味着：**任何
//! 一次重挂都必须先清空、再按全量配置重新挂上**。因此 [`register_all_global_hotkeys`]
//! 是唯一允许调用 `unregister_all()` 的地方，它负责按顺序挂两类热键：
//!
//! 1. 应用级热键（本模块，置顶前台窗口）；
//! 2. 插件启动热键（[`crate::services::plugin::register_plugin_hotkeys`]，它自己不清理）。
//!
//! 顺序不能反过来理解成「插件先挂、应用级后挂也没事」——只要有一处提前清了空，
//! 另一类热键就会被无声抹掉，症状是「改了一个插件的键，应用级快捷键失灵了」。
//!
//! # 为什么配置由 Rust 独占读写
//!
//! 两个键必须一起校验、一起落库、一起重挂：分成前端各写各的会出现「键已配好但启用状态
//! 没跟上」的半生效状态。因此它们刻意不进前端 `APP_SETTING_KEYS`，前端一律经命令读写。
//!
//! # 已知限制
//!
//! 应用级热键与某条插件热键用同一个组合键时，应用级先注册即生效，插件那条
//! `on_shortcut` 会失败并被记日志。不做跨域（应用 ↔ 插件）冲突检测。

use serde::Serialize;
use sqlx::{Row, SqlitePool};
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::domain::app::contract::SETTINGS_WINDOW_LABEL;
use crate::domain::app::settings;
use crate::domain::plugin::PLUGIN_WINDOW_LABEL_PREFIX;
use crate::infrastructure::database;
use crate::infrastructure::windows::foreground_topmost::{self, ForegroundPinOutcome};
use crate::services::plugin::{register_plugin_hotkeys, validate_accelerator};

/// `app_settings` 的三列，与前端 `shared/storage/database.ts` 的建表语句一致。
const KEY_COLUMN: &str = "key";
const VALUE_COLUMN: &str = "value";
const UPDATED_AT_COLUMN: &str = "updated_at";

/// 置顶快捷键在设置页里的可用状态。
///
/// 比插件热键少一个 `conflict`：应用级只有这一条热键，没有同类横向冲突可言；真正会
/// 撞车的是别处已注册的同键（插件热键），那条由插件侧报失败，不在这里体现。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ForegroundPinHotkeyStatus {
    /// 能正常注册。
    Ok,
    /// 含 Win / Super 的系统保留组合，注册必失败。
    SystemReserved,
    /// 缺少修饰键或主键（例如裸 `T`），会吞掉全局输入，被拒绝。
    Invalid,
    /// 用户显式禁用，或尚未配置快捷键。
    Disabled,
}

/// 置顶快捷键的生效配置与状态，供设置页回显。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForegroundPinHotkeyRegistration {
    /// 生效组合键；未配置时为空串。
    pub accelerator: String,
    /// 用户是否启用了这条快捷键；未配置或非法时启用无意义，状态会另行标注。
    pub enabled: bool,
    /// 当前状态：能不能真正注册上。
    pub status: ForegroundPinHotkeyStatus,
    /// 状态不是 `ok` 时的说明，设置页红字展示。
    pub message: Option<String>,
}

/// 重挂全部全局快捷键：先清空，再依次挂应用级与插件热键。
///
/// 调用方有三处：应用启动完成、用户改键（应用级或插件级）、插件目录重载。每一处都要求
/// 「按下一次按键就用新键」，因此这里每次都做全量重挂而不是增量对账。
pub async fn register_all_global_hotkeys(app: &AppHandle) -> Result<(), String> {
    // 清空必须在挂新键之前：若新键与某条旧键指向同一组合键，重复注册会直接报错。
    // 首次运行本就没有可注销的键，失败不致命，只记一行便于排查。
    if let Err(error) = app.global_shortcut().unregister_all() {
        eprintln!("[hotkey] 注销旧热键失败（可忽略首次运行）：{error}");
    }

    // 应用级热键失败只记日志、继续挂插件热键：两者互不依赖，一类配错不该连带另一类失效。
    register_foreground_pin_hotkey(app).await;

    register_plugin_hotkeys(app).await
}

/// 读取置顶快捷键的配置与状态。
///
/// 读不到配置不算错误：应用启动时前端尚未连库，此时正确语义就是「未配置」。
pub async fn list_foreground_pin_hotkey(
    app: &AppHandle,
) -> Result<ForegroundPinHotkeyRegistration, String> {
    let (accelerator, enabled) = read_config(app).await;
    let (status, message) = classify(&accelerator, enabled);

    Ok(ForegroundPinHotkeyRegistration {
        accelerator,
        enabled,
        message,
        status,
    })
}

/// 写入置顶快捷键配置（组合键 + 是否启用），并立即重挂全部全局快捷键。
///
/// 返回写入后的状态供设置页刷新展示：`enabled = false` 或清空快捷键时不需要先填一个
/// 能注册的键，因此这两种情况都跳过合法性校验。
pub async fn set_foreground_pin_hotkey(
    app: &AppHandle,
    accelerator: &str,
    enabled: bool,
) -> Result<ForegroundPinHotkeyRegistration, String> {
    if enabled && !accelerator.trim().is_empty() {
        validate_accelerator(accelerator)?;
    }

    let Some(pool) = database::resolve_app_sqlite_pool(app).await? else {
        return Err("存储尚未就绪，无法保存快捷键配置".into());
    };

    ensure_settings_storage(&pool).await?;
    write_setting(
        &pool,
        settings::keys::FOREGROUND_PIN_HOTKEY,
        &serde_json::to_string(accelerator)
            .map_err(|error| format!("序列化快捷键失败：{error}"))?,
    )
    .await?;
    write_setting(
        &pool,
        settings::keys::FOREGROUND_PIN_HOTKEY_ENABLED,
        &serde_json::to_string(&enabled).map_err(|error| format!("序列化启用状态失败：{error}"))?,
    )
    .await?;

    // 配置写库后立即重挂：用户改完希望「下一次按键就用新键」，而不是残留旧键。
    // 失败只记日志——数据库已落盘，快捷键状态以设置页为准，注册层偶发失败不该回滚配置。
    if let Err(error) = register_all_global_hotkeys(app).await {
        eprintln!("[hotkey] 保存快捷键配置后重注册失败：{error}");
    }

    list_foreground_pin_hotkey(app).await
}

/// 把当前启用的置顶快捷键挂到系统；未启用、未配置或非法时直接跳过。
async fn register_foreground_pin_hotkey(app: &AppHandle) {
    let registration = match list_foreground_pin_hotkey(app).await {
        Ok(registration) => registration,
        Err(error) => {
            eprintln!("[hotkey] 读取置顶快捷键配置失败，跳过本次注册：{error}");
            return;
        }
    };

    // 非法与禁用状态本就不该占用系统组合键；缺省不注册即「不生效」，无需显式注销。
    if !registration.enabled || registration.status != ForegroundPinHotkeyStatus::Ok {
        return;
    }

    // 回调是同步的，不能在里面 await：句柄解析与调度转包给工作线程，回调本身立即返回。
    if let Err(error) = app.global_shortcut().on_shortcut(
        registration.accelerator.as_str(),
        move |app, _shortcut, event| {
            // on_shortcut 对「按下 / 松开」都会回调一次，只在按下时触发，避免一次按键切换两回。
            if event.state == ShortcutState::Pressed {
                on_foreground_pin_triggered(app.clone());
            }
        },
    ) {
        eprintln!(
            "[hotkey] 注册置顶快捷键 {} 失败：{error}",
            registration.accelerator
        );
    }
}

/// 快捷键触发后的编排：在工作线程解析排除清单，再把纯数值的句柄投递回主线程执行。
///
/// 为什么不在回调里直接做：`WebviewWindow::hwnd()` 底层是「向主线程发消息并 `recv` 等待
/// 应答」，在主线程上调用会死锁，而 `SetWindowPos` 又必须在窗口归属线程（主线程）执行。
/// 因此拆成两步——解析在工作线程，Win32 操作在主线程。
fn on_foreground_pin_triggered(app: AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("foreground-pin".into())
        .spawn(move || {
            let excluded = collect_host_managed_window_handles(&app);
            let dispatch_app = app.clone();

            if let Err(error) = dispatch_app.run_on_main_thread(move || {
                report_outcome(foreground_topmost::toggle_foreground_topmost(&excluded));
            }) {
                eprintln!("[hotkey] 调度置顶切换失败：{error}");
            }
        });

    if let Err(error) = spawned {
        eprintln!("[hotkey] 启动置顶切换线程失败：{error}");
    }
}

/// 收集「由宿主自行管理层级」的窗口句柄，作为不该被置顶的排除清单。
///
/// Dasktop 自己的窗口里，只有设置窗（`main`）与插件窗口（`plugin_*`）允许被置顶：前者就是
/// 用户眼前的宿主界面，后者本就是用户真正想钉住的浮动工具窗。其余全部排除——Box 窗口
/// （`box_*`）的层级由 `desktop_glue` 按桌面状态每轮对账，框选覆盖层、Box 菜单、拖拽预览
/// 也都是宿主自己摆位的临时层，外部强塞 `WS_EX_TOPMOST` 会和这些逻辑互相打架。
///
/// 用排除法而不是硬编码标签清单：以后新增宿主窗口会自动落入排除范围，不必回来改这里。
fn collect_host_managed_window_handles(app: &AppHandle) -> Vec<isize> {
    app.webview_windows()
        .into_iter()
        .filter(|(label, _)| !is_pinnable_host_window(label))
        .filter_map(|(_, window)| window.hwnd().ok().map(|hwnd| hwnd.0 as isize))
        .collect()
}

/// 该标签的宿主窗口是否允许被置顶。
fn is_pinnable_host_window(window_label: &str) -> bool {
    window_label == SETTINGS_WINDOW_LABEL || window_label.starts_with(PLUGIN_WINDOW_LABEL_PREFIX)
}

/// 把切换结果写成一行日志。
///
/// 刻意不做系统级提示：项目没有零依赖的 OS 通知设施，而置顶效果本就发生在用户眼前的
/// 那个窗口上，本身可见。日志是排查「按了没反应」时唯一的线索。
fn report_outcome(outcome: Result<ForegroundPinOutcome, String>) {
    match outcome {
        Ok(ForegroundPinOutcome::Pinned) => eprintln!("[hotkey] 已置顶当前前台窗口"),
        Ok(ForegroundPinOutcome::Unpinned) => eprintln!("[hotkey] 已取消当前前台窗口的置顶"),
        Ok(ForegroundPinOutcome::NoTarget) => eprintln!("[hotkey] 当前没有可置顶的前台窗口"),
        Err(error) => eprintln!("[hotkey] 切换前台窗口置顶失败：{error}"),
    }
}

/// 读取已落库的置顶快捷键配置，读不到时回落到「未配置快捷键 + 启用」。
///
/// 启用状态缺省为 `true` 与插件热键一致：用户一旦配上键就该立即生效，不要把「还没配过」
/// 当成「用户关掉了」。真正被用户禁用过的记录会带着 `false` 被读出来，不会命中这个缺省值。
async fn read_config(app: &AppHandle) -> (String, bool) {
    let Some(pool) = database::resolve_app_sqlite_pool(app).await.ok().flatten() else {
        return (String::new(), true);
    };

    let accelerator = read_setting(&pool, settings::keys::FOREGROUND_PIN_HOTKEY)
        .await
        .and_then(|raw| serde_json::from_str::<String>(&raw).ok())
        .unwrap_or_default();

    let enabled = read_setting(&pool, settings::keys::FOREGROUND_PIN_HOTKEY_ENABLED)
        .await
        .and_then(|raw| serde_json::from_str::<bool>(&raw).ok())
        .unwrap_or(true);

    (accelerator, enabled)
}

/// 把配置收敛成展示状态。
///
/// 判定顺序与插件热键一致：禁用 / 未配置优先于一切，其次是快捷键本身是否合法。
fn classify(accelerator: &str, enabled: bool) -> (ForegroundPinHotkeyStatus, Option<String>) {
    if !enabled {
        return (ForegroundPinHotkeyStatus::Disabled, Some("已禁用".into()));
    }

    if accelerator.trim().is_empty() {
        return (
            ForegroundPinHotkeyStatus::Disabled,
            Some("未配置快捷键".into()),
        );
    }

    if let Err(reason) = validate_accelerator(accelerator) {
        // 系统保留与格式非法共用同一套文案，靠关键词分流到两种状态。
        let status = if reason.contains("系统保留") {
            ForegroundPinHotkeyStatus::SystemReserved
        } else {
            ForegroundPinHotkeyStatus::Invalid
        };

        return (status, Some(reason));
    }

    (ForegroundPinHotkeyStatus::Ok, None)
}

/// 读取 `app_settings` 里某一项设置的原样（JSON）值，读不到返回 `None`。
///
/// 值由两端以 JSON 序列化写入（前端 `JSON.stringify`、本模块 `serde_json`），因此这里
/// 取原始字符串交由调用方解析，而不是在 SQL 层做类型转换。
async fn read_setting(pool: &SqlitePool, key: &str) -> Option<String> {
    let table_name = settings::APP_SETTINGS_TABLE;
    let query = format!("SELECT {VALUE_COLUMN} FROM {table_name} WHERE {KEY_COLUMN} = ?");
    let row = sqlx::query(&query)
        .bind(key)
        .fetch_optional(pool)
        .await
        .ok()??;

    row.try_get::<String, _>(VALUE_COLUMN).ok()
}

/// 按 `key` 覆盖写入一项设置，值必须是已序列化好的 JSON 文本。
///
/// 走 `ON CONFLICT(key)` 而不是「先删后插」：`app_settings` 的主键由本模块与前端共用同一份
/// 建表语句保证，不存在插件热键表那样的陈旧 schema 风险。
async fn write_setting(pool: &SqlitePool, key: &str, value: &str) -> Result<(), String> {
    let table_name = settings::APP_SETTINGS_TABLE;
    let query = format!(
        "
        INSERT INTO {table_name} ({KEY_COLUMN}, {VALUE_COLUMN}, {UPDATED_AT_COLUMN})
        VALUES (?, ?, ?)
        ON CONFLICT({KEY_COLUMN}) DO UPDATE SET
          {VALUE_COLUMN} = excluded.{VALUE_COLUMN},
          {UPDATED_AT_COLUMN} = excluded.{UPDATED_AT_COLUMN}
        "
    );

    sqlx::query(&query)
        .bind(key)
        .bind(value)
        .bind(current_timestamp_millis())
        .execute(pool)
        .await
        .map_err(|error| format!("保存快捷键配置失败：{error}"))?;

    Ok(())
}

/// 确保 `app_settings` 表存在。
///
/// 与前端 `shared/storage/database.ts` 的 `initializeStorage` 是同一张表，两端都保留建表
/// 语句：写配置的请求可能发生在设置窗尚未初始化存储的时刻（例如刚唤起应用就去改键），
/// 只依赖前端建表会让那次写入失败。
async fn ensure_settings_storage(pool: &SqlitePool) -> Result<(), String> {
    let table_name = settings::APP_SETTINGS_TABLE;
    let create = format!(
        "
        CREATE TABLE IF NOT EXISTS {table_name} (
          {KEY_COLUMN} TEXT PRIMARY KEY,
          {VALUE_COLUMN} TEXT NOT NULL,
          {UPDATED_AT_COLUMN} INTEGER NOT NULL
        )
        "
    );

    sqlx::query(&create)
        .execute(pool)
        .await
        .map_err(|error| format!("初始化设置存储失败：{error}"))?;

    Ok(())
}

/// 当前时间的毫秒时间戳，与前端 `Date.now()` 同一基准。
///
/// 失败时退化为 0：`updated_at` 只用于判断同一主键上的先后，取不到真实时间不影响配置逻辑。
fn current_timestamp_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}
