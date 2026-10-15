//! 插件启动热键的注册状态聚合、宿主配置持久化与系统级注册。
//!
//! 热键配置完全由宿主端持有：用户在设置页为每个已安装插件配置一个「启动热键」，
//! 不再由插件在 `plugin.json` 里声明。本模块因此只有三层职责：
//!
//! 1. 聚合「已安装插件 + 宿主配置表」算出每个插件的生效启动热键与状态
//!    （合法 / 冲突 / 未配置 / 禁用）；
//! 2. 把用户的配置落库；
//! 3. 在启动 / 重载时把有效热键真正挂到系统（`tauri-plugin-global-shortcut`），
//!    触发时按 `plugin_id` 路由到对应窗口。
//!
//! # 与声明式模型的区别
//!
//! 旧模型里热键由插件各自声明多条，冲突裁决对象是「所有插件的所有声明」；本模型每个插件
//! 只配一个启动热键，冲突裁决仍是「所有插件之间的横向关系」，只是每个插件最多贡献一条，
//! 唯一性按生效快捷键统计的逻辑不变。

use std::collections::HashMap;

use serde::Serialize;
use sqlx::{Row, SqlitePool};
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::domain::plugin::PLUGIN_WINDOW_LABEL_PREFIX;
use crate::infrastructure::database;
use crate::services::plugin;

/// 一个插件的启动热键在设置页里的状态。
///
/// 简化自声明式模型的「多热键」：`plugin_id` 唯一决定一行，不再有 `hotkey_id` 与 `title`
/// —— 启动热键的语义是「打开这个插件」，意图不需要插件内再路由，插件 id 即自解释。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginHotkeyRegistration {
    /// 热键所属插件 id。
    pub plugin_id: String,
    /// 生效快捷键：宿主配置里写下的组合键；未配置时为空串，表示「暂未设定」。
    pub accelerator: String,
    /// 用户是否启用了这条启动热键；空快捷键或冲突时启用无意义，状态会另行标注。
    pub enabled: bool,
    /// 当前状态：能不能真正注册上。
    pub status: PluginHotkeyStatus,
    /// 状态不是 `ok` 时的说明，设置页红字展示。
    pub message: Option<String>,
}

/// 单条启动热键的注册状态。
///
/// 大小写由 serde 转成 camelCase 后与前端的 `PluginHotkeyStatus` 对应：前端据此选文案
/// 与配色，新增状态而前端没收到的情况会在渲染时暴露成空白说明行，比悄悄回落到
/// 某个解释不通的状态更容易被发现。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PluginHotkeyStatus {
    /// 能正常注册。
    Ok,
    /// 用户或系统保留组合（含 Win 键），注册必失败。
    SystemReserved,
    /// 缺少修饰键或主键（例如裸 `T`），会吞掉全局输入，被拒绝。
    Invalid,
    /// 与其它插件的启动热键重复，先到先得，后来者不注册。
    Conflict,
    /// 用户显式禁用，或未配置快捷键。
    Disabled,
}

const PLUGIN_ID_COLUMN: &str = "plugin_id";
const ACCELERATOR_COLUMN: &str = "accelerator";
const ENABLED_COLUMN: &str = "enabled";
const UPDATED_AT_COLUMN: &str = "updated_at";
const TABLE_NAME: &str = "plugin_hotkeys";

/// 列出全部插件的启动热键状态，叠加宿主配置并标注冲突 / 非法 / 未配置。
///
/// 返回顺序与 `list_plugins` 一致（按插件 id 升序），设置页不需要再排序。
pub async fn list_plugin_hotkeys(app: &AppHandle) -> Result<Vec<PluginHotkeyRegistration>, String> {
    let scan = plugin::scan_plugin_packages(app).await?;
    let config = load_host_config(app).await;

    // 先收集所有插件的生效键，再统一判冲突：冲突是「所有插件之间的横向关系」，
    // 必须把全量摊开后按生效快捷键统计，逐条先算再比对会漏掉后半段。
    let mut drafts: Vec<RegistrationDraft> = Vec::new();

    for package in &scan.packages {
        // 清单损坏的包不提供界面，也没有资格配启动热键。
        if package.manifest.is_none() {
            continue;
        }

        let entry = config.get(&package.id);
        let accelerator = entry.map(|(accelerator, _)| accelerator.clone()).unwrap_or_default();
        // 未配置过启动热键的插件默认「启用」：用户一旦在设置页配了键就该立即生效，
        // 不要把缺省当成「关掉」。真正被用户禁用过的插件在表里留下 enabled=0，会命中上面的
        // entry 分支而不会落到这个缺省值；空快捷键只是「未配置」状态，不会真的占用系统热键。
        let enabled = entry.map(|(_, enabled)| *enabled).unwrap_or(true);

        drafts.push(RegistrationDraft {
            accelerator,
            enabled,
            plugin_id: package.id.clone(),
        });
    }

    let mut occurrence: HashMap<String, usize> = HashMap::new();
    for draft in &drafts {
        if !draft.accelerator.trim().is_empty() {
            *occurrence
                .entry(normalize_accelerator(&draft.accelerator))
                .or_insert(0) += 1;
        }
    }

    let mut registrations = Vec::with_capacity(drafts.len());
    for draft in drafts {
        let normalized = normalize_accelerator(&draft.accelerator);
        let (status, message) =
            classify(&draft, occurrence.get(&normalized).copied().unwrap_or(0));

        registrations.push(PluginHotkeyRegistration {
            accelerator: draft.accelerator,
            enabled: draft.enabled,
            message,
            plugin_id: draft.plugin_id,
            status,
        });
    }

    Ok(registrations)
}

/// 写入或更新某插件的启动热键配置（生效快捷键 + 是否启用）。
///
/// 配置必须指向真实安装的插件：用户不能给不存在的插件配热键，否则设置页改完却
/// 永远没有插件去读它，排查时只会以为「宿主没生效」。禁用 / 未配置时不需要合法快捷键。
pub async fn set_plugin_hotkey(
    app: &AppHandle,
    plugin_id: &str,
    accelerator: &str,
    enabled: bool,
) -> Result<(), String> {
    // 配置必须指向真实安装的插件：用户不能凭空造一条；禁用一条热键时不需要先填合法快捷键，
    // 因此 `enabled = false` 会跳过快捷键合法性校验。
    let scan = plugin::scan_plugin_packages(app).await?;
    let exists = scan.packages.iter().any(|package| package.id == plugin_id);

    if !exists {
        return Err(format!("插件 {plugin_id} 未安装，无法配置启动热键"));
    }

    // 禁用时不需要合法快捷键：用户关掉一条热键没必要先填一个能注册的键。
    if enabled && !accelerator.trim().is_empty() {
        validate_accelerator(accelerator)?;
    }

    let Some(pool) = database::resolve_app_sqlite_pool(app).await? else {
        return Err("存储尚未就绪，无法保存热键配置".into());
    };

    ensure_storage(&pool).await?;

    // 用「先删后插」而不是 `ON CONFLICT`：早期版本建的表可能没有主键 / 唯一约束，
    // `ON CONFLICT(plugin_id)` 会直接报「没有主键或唯一约束」导致写库永远失败。
    // 先删后插不依赖任何约束，对陈旧 schema 也能落库；顺带清掉同名旧行、避免重复。
    let delete_query = format!("DELETE FROM {TABLE_NAME} WHERE {PLUGIN_ID_COLUMN} = ?");
    sqlx::query(&delete_query)
        .bind(plugin_id)
        .execute(&pool)
        .await
        .map_err(|error| format!("清除旧热键配置失败：{error}"))?;

    let insert_query = format!(
        "
        INSERT INTO {TABLE_NAME} ({PLUGIN_ID_COLUMN}, {ACCELERATOR_COLUMN}, {ENABLED_COLUMN}, {UPDATED_AT_COLUMN})
        VALUES (?, ?, ?, ?)
        "
    );
    sqlx::query(&insert_query)
        .bind(plugin_id)
        .bind(accelerator)
        .bind(if enabled { 1i64 } else { 0i64 })
        .bind(current_timestamp_millis())
        .execute(&pool)
        .await
        .map_err(|error| format!("保存热键配置失败：{error}"))?;

    // 配置写库后立即重挂系统热键：用户改完希望「下一次按键就用新键」，而不是残留旧键。
    // 失败只记日志——数据库已落盘，热键状态以设置页为准，注册层偶发失败不该回滚用户的配置。
    if let Err(error) = register_all_plugin_hotkeys(app).await {
        eprintln!("[plugin] 保存热键配置后重注册失败：{error}");
    }

    Ok(())
}

/// 把全部有效启动热键挂到系统全局快捷键。
///
/// 调用方应在两处触发：应用启动完成（setup 已 spawn）与用户改键 / 重载插件之后。
/// 每次都先清空再全量重挂，而不是做增量对账：覆盖改键后旧键必须注销，否则会留下一个
/// 「改了却还生效」的幽灵键；而全量重挂比「精确算出哪条变了」简单，插件热键数量本就有限。
pub async fn register_all_plugin_hotkeys(app: &AppHandle) -> Result<(), String> {
    // 清空必须在挂新键之前：若新键与某条旧键指向同一组合键，重复注册会直接报错。
    // 首次运行本就没有可注销的键，失败不致命，只记一行便于排查。
    if let Err(error) = app.global_shortcut().unregister_all() {
        eprintln!("[plugin] 注销旧热键失败（可忽略首次运行）：{error}");
    }

    let registrations = match list_plugin_hotkeys(app).await {
        Ok(registrations) => registrations,
        Err(error) => {
            // 读不到清单就不注册，而不是抛错中断启动；热键是锦上添花，不该拖垮主流程。
            eprintln!("[plugin] 读取热键注册状态失败，跳过本次注册：{error}");
            return Ok(());
        }
    };

    for registration in registrations {
        // 禁用与异常状态本就不该占用系统组合键；缺省不注册即「不生效」，无需显式注销。
        if !registration.enabled || registration.status != PluginHotkeyStatus::Ok {
            continue;
        }

        let plugin_id = registration.plugin_id.clone();

        // 回调是同步的，不能在里面 await：建窗这种异步活儿转包给 tokio 线程，
        // 与 open_plugin_window 命令走同一条建窗路径，行为一致。
        // 用 on_shortcut 而非 register：前者在注册的同时绑定回调，回调签名
        // Fn(&AppHandle, &Shortcut, ShortcutEvent)；register 不带回调，无法满足「按键即唤起」的诉求。
        if let Err(error) = app.global_shortcut().on_shortcut(
            registration.accelerator.as_str(),
            move |app, _shortcut, event| {
                // on_shortcut 对「按下 / 松开」都会回调一次，只在按下时触发：
                // 否则松开瞬间窗口还没建好，会二次 spawn、开出两个窗口。
                if event.state == ShortcutState::Pressed {
                    on_hotkey_triggered(app.clone(), plugin_id.clone());
                }
            },
        ) {
            // 单条注册失败不影响其余：冲突等情况在 list 时已标成 conflict，这里再失败通常是
            // 系统层偶发，记录即可，不该让整次注册崩掉。
            eprintln!("[plugin] 注册热键 {} 失败：{error}", registration.accelerator);
        }
    }

    Ok(())
}

/// 启动热键触发时的统一入口：窗口已在就唤起（注入脚本 + 聚焦），不在就建窗。
///
/// 窗口已存在时，插件页面已经挂好了 `dasktop.hotkey.onTrigger` 回调，用注入 JS 直接触发它，
/// 再把窗口顶到前台；首次建窗的意图则走初始化脚本注入，由 `open_plugin_window` 的 trigger
/// 分支负责（见 [`crate::services::plugin::open_plugin_window`]）。
fn on_hotkey_triggered(app: AppHandle, plugin_id: String) {
    let label = format!("{PLUGIN_WINDOW_LABEL_PREFIX}{plugin_id}");

    // 窗口已存在：直接唤起。再次唤起走「页面已挂监听」的路径。
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.eval(&fire_hotkey_script());
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    // 窗口不存在：走与「设置页点开」完全相同的建窗路径，只是带上了唤起意图，
    // 让插件页面一加载就知道「我是被热键叫醒的」。
    tauri::async_runtime::spawn(async move {
        if let Err(error) =
            plugin::open_plugin_window(&app, &plugin_id, Some("")).await
        {
            eprintln!("[plugin] 热键唤起建窗失败 {plugin_id}：{error}");
        }
    });
}

/// 拼出注入到插件窗口、用于触发 onTrigger 回调的 JS。
///
/// 用 `&&` 短路：插件未注册回调时静默无操作而不是抛 ReferenceError。窗口已存在路径
/// 走这里，首次建窗的意图则在 bridge 的初始化脚本里被 `dasktop.hotkey.onTrigger` 读走。
fn fire_hotkey_script() -> String {
    "window.__dasktop_fire_hotkey && window.__dasktop_fire_hotkey();".to_string()
}

/// 把一条插件配置与它的生效状态收敛成展示状态。
///
/// 判定顺序有讲究：禁用与未配置优先于一切（关掉的 / 没配的无需讨论能不能注册），
/// 其次是快捷键本身是否合法（系统保留 / 格式非法），最后才是横向的冲突——后者要求
/// 看到全量配置才能判，因此 `count` 由调用方统计后传入。
fn classify(draft: &RegistrationDraft, count: usize) -> (PluginHotkeyStatus, Option<String>) {
    if !draft.enabled {
        return (PluginHotkeyStatus::Disabled, Some("已禁用".into()));
    }

    if draft.accelerator.trim().is_empty() {
        return (PluginHotkeyStatus::Disabled, Some("未配置快捷键".into()));
    }

    if let Err(reason) = validate_accelerator(&draft.accelerator) {
        // 系统保留与格式非法共用一套文案里带了不同关键词，靠它分流到两种状态。
        let status = if reason.contains("系统保留") {
            PluginHotkeyStatus::SystemReserved
        } else {
            PluginHotkeyStatus::Invalid
        };

        return (status, Some(reason));
    }

    if count > 1 {
        return (
            PluginHotkeyStatus::Conflict,
            Some("与其它插件的启动热键冲突，仅最先注册的生效".into()),
        );
    }

    (PluginHotkeyStatus::Ok, None)
}

/// 校验快捷键字符串是否可被注册。
///
/// 规则与 `scripts/verify-plugins.mjs` 之前对 manifest 的规则一致：至少一个修饰键
/// （Ctrl / Alt / Shift / Meta 之一）且至少一个主键；含 Win / Super 的组合系统保留，
/// 注册必静默失败，不如在配置期就拦下。返回 `Err` 时携带给用户的说明文字。
///
/// 注：manifest 不再声明热键，`verify-plugins` 已不再校验插件包内的热键字符串；
/// 这里的校验服务于宿主端为用户填写的启动热键。
fn validate_accelerator(accelerator: &str) -> Result<(), String> {
    let tokens: Vec<String> = accelerator
        .split('+')
        .map(|token| token.trim().to_lowercase())
        .filter(|token| !token.is_empty())
        .collect();

    if tokens.len() < 2 {
        return Err("快捷键必须包含至少一个修饰键和一个主键（例如 Alt+T）".into());
    }

    let modifiers = ["ctrl", "control", "alt", "shift", "meta", "cmd", "command", "option"];
    let has_modifier = tokens.iter().any(|token| modifiers.contains(&token.as_str()));
    let has_key = tokens.iter().any(|token| !modifiers.contains(&token.as_str()));

    if !has_modifier || !has_key {
        return Err("快捷键必须包含至少一个修饰键和一个主键（例如 Alt+T）".into());
    }

    if tokens.iter().any(|token| token == "super" || token == "win") {
        return Err("Windows 徽标键（Win / Super）组合会被系统保留，无法注册".into());
    }

    Ok(())
}

/// 把快捷键字符串标准化成比较键。
///
/// 用户可能写成 `alt + T`、`Alt+T` 等多种形态，比较冲突前统一小写并去掉空白，
/// 避免「同一条组合键因为写法不同而被判成不冲突」。不解析具体按键语义——那交给注册层。
fn normalize_accelerator(accelerator: &str) -> String {
    accelerator
        .split('+')
        .map(|token| token.trim().to_lowercase())
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>()
        .join("+")
}

/// 读取宿主启动热键配置表，键为 `plugin_id`。
///
/// 任何一步失败都返回空映射：配置是偏好，读不到应当回落到「没有启动热键」，
/// 而不是让整次列表失败。
async fn load_host_config(app: &AppHandle) -> HashMap<String, (String, bool)> {
    let Some(pool) = database::resolve_app_sqlite_pool(app).await.ok().flatten() else {
        return HashMap::new();
    };

    if ensure_storage(&pool).await.is_err() {
        return HashMap::new();
    }

    let query = format!(
        "SELECT {PLUGIN_ID_COLUMN}, {ACCELERATOR_COLUMN}, {ENABLED_COLUMN} FROM {TABLE_NAME}"
    );

    let Ok(rows) = sqlx::query(&query).fetch_all(&pool).await else {
        return HashMap::new();
    };

    let mut config = HashMap::new();
    for row in rows {
        let Ok(plugin_id) = row.try_get::<String, _>(PLUGIN_ID_COLUMN) else {
            continue;
        };
        let Ok(accelerator) = row.try_get::<String, _>(ACCELERATOR_COLUMN) else {
            continue;
        };
        let Ok(enabled_raw) = row.try_get::<i64, _>(ENABLED_COLUMN) else {
            continue;
        };

        config.insert(plugin_id, (accelerator, enabled_raw != 0));
    }

    config
}

/// 确保启动热键配置表存在。
///
/// 与前端 `shared/storage/database.ts` 的 `ensurePluginHotkeyStorage` 是同一张表，两端都
/// 保留建表语句：注册层可能在设置窗尚未连库时就需要读配置（例如托盘常驻期间的热键注册）。
async fn ensure_storage(pool: &SqlitePool) -> Result<(), String> {
    let create = format!(
        "
        CREATE TABLE IF NOT EXISTS {TABLE_NAME} (
          {PLUGIN_ID_COLUMN} TEXT NOT NULL PRIMARY KEY,
          {ACCELERATOR_COLUMN} TEXT NOT NULL,
          {ENABLED_COLUMN} INTEGER NOT NULL DEFAULT 1,
          {UPDATED_AT_COLUMN} INTEGER NOT NULL
        )
        "
    );

    sqlx::query(&create)
        .execute(pool)
        .await
        .map_err(|error| format!("初始化热键存储失败：{error}"))?;

    // 老版本可能建出了缺列或缺主键的表（`CREATE TABLE IF NOT EXISTS` 不会改造已存在的表）。
    // 写入用「先删后插」已不依赖主键，但仍依赖四列齐全；这里核对列名，缺任何一列就整表重建。
    let rows = sqlx::query(&format!("PRAGMA table_info({TABLE_NAME})"))
        .fetch_all(pool)
        .await
        .map_err(|error| format!("读取热键表结构失败：{error}"))?;

    let mut columns: Vec<String> = Vec::new();
    for row in &rows {
        if let Ok(name) = row.try_get::<String, _>("name") {
            columns.push(name);
        }
    }

    let expected = [PLUGIN_ID_COLUMN, ACCELERATOR_COLUMN, ENABLED_COLUMN, UPDATED_AT_COLUMN];
    // 列必须「恰好」是这四列：老声明式模型的表多出 `hotkey_id`（NOT NULL），
    // 只查「缺没缺」会漏掉这种多余列，INSERT 缺了该列的值仍会失败。
    let complete = columns.len() == expected.len()
        && expected
            .iter()
            .all(|column| columns.iter().any(|name| name == column));
    if !complete {
        sqlx::query(&format!("DROP TABLE {TABLE_NAME}"))
            .execute(pool)
            .await
            .map_err(|error| format!("重建热键表（删旧表）失败：{error}"))?;
        sqlx::query(&create)
            .execute(pool)
            .await
            .map_err(|error| format!("重建热键表（建新表）失败：{error}"))?;
    }

    Ok(())
}

/// 扫描期聚合用的轻量草稿，避免与最终序列化结构耦合。
struct RegistrationDraft {
    accelerator: String,
    enabled: bool,
    plugin_id: String,
}

/// 当前时间的毫秒时间戳。
///
/// 失败时退化为 0：`updated_at` 只用于同一主键上的先后判断，取不到真实时间不影响
/// 配置逻辑本身（同一插件只有一行）。
fn current_timestamp_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}
