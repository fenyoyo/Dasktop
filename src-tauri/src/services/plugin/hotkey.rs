//! 插件全局热键的注册状态聚合与用户覆盖持久化。
//!
//! 本模块**只做数据与状态计算**，真正的系统级注册（`tauri-plugin-global-shortcut` 的
//! 挂接、回调里 spawn 建窗、唯一性裁决的注册期反馈）由注册层消费这里产出的
//! `PluginHotkeyRegistration` 列表去执行。这样扫描期就能把「哪些热键会被注册、各自什么
//! 状态」算清楚并交给设置页展示，注册层只负责「按这份清单去挂系统热键」。
//!
//! # 为什么包间冲突在这里就能算
//!
//! 冲突的本质是「两个声明落到同一个系统组合键上」，而声明全部在清单里，宿主扫描时
//! 已经拿到全部插件。唯一性裁决「先到先得」也只需按插件 id 字典序排定先后——这些信息
//! 都不依赖系统注册结果，因此扫描期就能给出 `conflict` 状态，不必等到真正注册失败。

use std::collections::HashMap;

use serde::Serialize;
use sqlx::{Row, SqlitePool};
use tauri::AppHandle;

use crate::infrastructure::database;
use crate::services::plugin;

/// 一条热键在设置页里的展示 / 持久化形态。
///
/// 它同时承载「插件的声明」「用户的覆盖」与「当前状态」：三者合在一起，设置页才不用
/// 分别去三处拼装。状态枚举见 [`PluginHotkeyStatus`]。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginHotkeyRegistration {
    /// 热键所属插件 id。
    pub plugin_id: String,
    /// 热键在包内唯一标识。
    pub hotkey_id: String,
    /// 面向用户的说明，可能来自清单或为空。
    pub title: Option<String>,
    /// 清单里声明的原始快捷键，设置页用它说明「作者建议是什么」。
    pub declared_accelerator: String,
    /// 实际生效的快捷键：用户没覆盖时用声明的，覆盖后用覆盖的。
    pub accelerator: String,
    /// 用户是否启用了这条热键；覆盖成 false 即不注册。
    pub enabled: bool,
    /// 当前状态：能不能真正注册上。
    pub status: PluginHotkeyStatus,
    /// 状态不是 `ok` 时的说明，设置页红字展示。
    pub message: Option<String>,
}

/// 单条热键的注册状态。
///
/// 大小写由 serde 转成 camelCase 后与前端的 `PluginHotkeyStatus` 对应：前端据此选文案
/// 与配色，新增状态而前端没收到的情况会在渲染时暴露成空白说明行，比悄悄回落到
/// 某个解释不通的状态更容易被发现。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PluginHotkeyStatus {
    /// 能正常注册。
    Ok,
    /// 用户或插件声明了系统保留组合（含 Win 键），注册必失败。
    SystemReserved,
    /// 缺少修饰键或主键（例如裸 `T`），会吞掉全局输入，被拒绝。
    Invalid,
    /// 与其它声明重复，先到先得，后来者不注册。
    Conflict,
    /// 用户显式禁用。
    Disabled,
}

const PLUGIN_ID_COLUMN: &str = "plugin_id";
const HOTKEY_ID_COLUMN: &str = "hotkey_id";
const ACCELERATOR_COLUMN: &str = "accelerator";
const ENABLED_COLUMN: &str = "enabled";
const UPDATED_AT_COLUMN: &str = "updated_at";
const TABLE_NAME: &str = "plugin_hotkeys";

/// 列出全部插件热键的注册状态，叠加用户覆盖并标注冲突 / 非法。
///
/// 返回顺序是「按插件 id 升序、每个插件内按热键声明顺序」，与设置页展示一致，
/// 前端不需要再排序。
pub async fn list_plugin_hotkeys(app: &AppHandle) -> Result<Vec<PluginHotkeyRegistration>, String> {
    let scan = plugin::scan_plugin_packages(app).await?;
    let overrides = load_overrides(app).await;

    // 先扁平化所有声明并叠加用户覆盖，再统一判冲突：冲突是「所有声明之间的横向关系」，
    // 必须把全量摊开后按生效快捷键统计，逐条先算再比对会漏掉后半段。
    let mut drafts: Vec<RegistrationDraft> = Vec::new();

    for package in &scan.packages {
        let Some(manifest) = &package.manifest else {
            continue;
        };

        for hotkey in &manifest.hotkeys {
            let key = (package.id.clone(), hotkey.id.clone());
            let override_entry = overrides.get(&key);

            let accelerator = override_entry
                .map(|(accelerator, _)| accelerator.clone())
                .unwrap_or_else(|| hotkey.accelerator.clone());
            let enabled = override_entry.map(|(_, enabled)| *enabled).unwrap_or(true);

            drafts.push(RegistrationDraft {
                accelerator,
                declared_accelerator: hotkey.accelerator.clone(),
                enabled,
                hotkey_id: hotkey.id.clone(),
                plugin_id: package.id.clone(),
                title: hotkey.title.clone(),
            });
        }
    }

    // 按标准化后的快捷键统计出现次数：命中多次（哪怕来自同一插件的两个不同 id）都判冲突。
    let mut occurrence: HashMap<String, usize> = HashMap::new();
    for draft in &drafts {
        *occurrence.entry(normalize_accelerator(&draft.accelerator)).or_insert(0) += 1;
    }

    let mut registrations = Vec::with_capacity(drafts.len());
    for draft in drafts {
        let normalized = normalize_accelerator(&draft.accelerator);
        let (status, message) =
            classify(&draft, occurrence.get(&normalized).copied().unwrap_or(0));

        registrations.push(PluginHotkeyRegistration {
            accelerator: draft.accelerator,
            declared_accelerator: draft.declared_accelerator,
            enabled: draft.enabled,
            hotkey_id: draft.hotkey_id,
            message,
            plugin_id: draft.plugin_id,
            status,
            title: draft.title,
        });
    }

    Ok(registrations)
}

/// 写入或更新某条热键的用户覆盖（生效快捷键 + 是否启用）。
///
/// 覆盖必须针对真实声明的热键：用户不能凭空造一条；禁用一条热键时不需要先填合法快捷键，
/// 因此 `enabled = false` 会跳过快捷键合法性校验。
pub async fn set_plugin_hotkey(
    app: &AppHandle,
    plugin_id: &str,
    hotkey_id: &str,
    accelerator: &str,
    enabled: bool,
) -> Result<(), String> {
    // 覆盖必须指向真实存在的声明：用户不能凭空造一条热键，否则设置页改完却永远没有
    // 任何插件去读它，排查时只会以为「宿主没生效」。
    let scan = plugin::scan_plugin_packages(app).await?;
    let exists = scan.packages.iter().any(|package| {
        package.id == plugin_id
            && package
                .manifest
                .as_ref()
                .is_some_and(|manifest| manifest.hotkeys.iter().any(|hotkey| hotkey.id == hotkey_id))
    });

    if !exists {
        return Err(format!("插件 {plugin_id} 未声明热键 {hotkey_id}"));
    }

    // 禁用时不需要合法快捷键：用户关掉一条热键没必要先填一个能注册的键。
    if enabled && !accelerator.trim().is_empty() {
        validate_accelerator(accelerator)?;
    }

    let Some(pool) = database::resolve_app_sqlite_pool(app).await? else {
        return Err("存储尚未就绪，无法保存热键覆盖".into());
    };

    ensure_storage(&pool).await?;

    let query = format!(
        "
        INSERT INTO {TABLE_NAME} ({PLUGIN_ID_COLUMN}, {HOTKEY_ID_COLUMN}, {ACCELERATOR_COLUMN}, {ENABLED_COLUMN}, {UPDATED_AT_COLUMN})
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT({PLUGIN_ID_COLUMN}, {HOTKEY_ID_COLUMN}) DO UPDATE SET
          {ACCELERATOR_COLUMN} = excluded.{ACCELERATOR_COLUMN},
          {ENABLED_COLUMN} = excluded.{ENABLED_COLUMN},
          {UPDATED_AT_COLUMN} = excluded.{UPDATED_AT_COLUMN}
        "
    );

    sqlx::query(&query)
        .bind(plugin_id)
        .bind(hotkey_id)
        .bind(accelerator)
        .bind(if enabled { 1i64 } else { 0i64 })
        .bind(current_timestamp_millis())
        .execute(&pool)
        .await
        .map_err(|error| format!("保存热键覆盖失败：{error}"))?;

    Ok(())
}

/// 把一条热键声明与它的用户覆盖收敛成展示状态。
///
/// 判定顺序有讲究：禁用优先于一切（关掉的热键无需讨论能不能注册），其次是快捷键本身
/// 是否合法（系统保留 / 格式非法），最后才是横向的冲突——后者要求看到全量声明才能判，
/// 因此 `count` 由调用方统计后传入。
fn classify(draft: &RegistrationDraft, count: usize) -> (PluginHotkeyStatus, Option<String>) {
    if !draft.enabled {
        return (PluginHotkeyStatus::Disabled, Some("已禁用".into()));
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
            Some("与其它插件热键冲突，仅最先注册的生效".into()),
        );
    }

    (PluginHotkeyStatus::Ok, None)
}

/// 校验快捷键字符串是否可被注册。
///
/// 规则与 `scripts/verify-plugins.mjs` 一致：至少一个修饰键（Ctrl / Alt / Shift / Meta 之一）
/// 且至少一个主键；含 Win / Super 的组合系统保留，注册必静默失败，不如在声明期就拦下。
/// 返回 `Err` 时携带给用户的说明文字。
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

/// 读取用户热键覆盖表，键为 `(plugin_id, hotkey_id)`。
///
/// 任何一步失败都返回空映射：覆盖是偏好，读不到应当回落到「用清单声明的快捷键」，
/// 而不是让整次列表失败。
async fn load_overrides(app: &AppHandle) -> HashMap<(String, String), (String, bool)> {
    let Some(pool) = database::resolve_app_sqlite_pool(app).await.ok().flatten() else {
        return HashMap::new();
    };

    if ensure_storage(&pool).await.is_err() {
        return HashMap::new();
    }

    let query = format!(
        "SELECT {PLUGIN_ID_COLUMN}, {HOTKEY_ID_COLUMN}, {ACCELERATOR_COLUMN}, {ENABLED_COLUMN} FROM {TABLE_NAME}"
    );

    let Ok(rows) = sqlx::query(&query).fetch_all(&pool).await else {
        return HashMap::new();
    };

    let mut overrides = HashMap::new();
    for row in rows {
        let Ok(plugin_id) = row.try_get::<String, _>(PLUGIN_ID_COLUMN) else {
            continue;
        };
        let Ok(hotkey_id) = row.try_get::<String, _>(HOTKEY_ID_COLUMN) else {
            continue;
        };
        let Ok(accelerator) = row.try_get::<String, _>(ACCELERATOR_COLUMN) else {
            continue;
        };
        let Ok(enabled_raw) = row.try_get::<i64, _>(ENABLED_COLUMN) else {
            continue;
        };

        overrides.insert((plugin_id, hotkey_id), (accelerator, enabled_raw != 0));
    }

    overrides
}

/// 确保热键覆盖表存在。
///
/// 与前端 `shared/storage/database.ts` 的 `ensurePluginHotkeyStorage` 是同一张表，两端都
/// 保留建表语句：注册层可能在设置窗尚未连库时就需要读覆盖（例如托盘常驻期间的热键注册）。
async fn ensure_storage(pool: &SqlitePool) -> Result<(), String> {
    let query = format!(
        "
        CREATE TABLE IF NOT EXISTS {TABLE_NAME} (
          {PLUGIN_ID_COLUMN} TEXT NOT NULL,
          {HOTKEY_ID_COLUMN} TEXT NOT NULL,
          {ACCELERATOR_COLUMN} TEXT NOT NULL,
          {ENABLED_COLUMN} INTEGER NOT NULL DEFAULT 1,
          {UPDATED_AT_COLUMN} INTEGER NOT NULL,
          PRIMARY KEY ({PLUGIN_ID_COLUMN}, {HOTKEY_ID_COLUMN})
        )
        "
    );

    sqlx::query(&query)
        .execute(pool)
        .await
        .map_err(|error| format!("初始化热键存储失败：{error}"))?;

    Ok(())
}

/// 扫描期聚合用的轻量草稿，避免与最终序列化结构耦合。
struct RegistrationDraft {
    accelerator: String,
    declared_accelerator: String,
    enabled: bool,
    hotkey_id: String,
    plugin_id: String,
    title: Option<String>,
}

/// 当前时间的毫秒时间戳。
///
/// 失败时退化为 0：`updated_at` 只用于同一主键上的先后判断，取不到真实时间不影响
/// 覆盖逻辑本身（同一插件热键只有一行）。
fn current_timestamp_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}
