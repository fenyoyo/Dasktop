//! 插件服务层。
//!
//! 负责四件事：把「应用数据目录」翻译成插件根目录、把基础设施的包内文件操作包装成
//! 面向插件 id 的用例、把宿主通知落到 Tauri 事件上、以及为插件窗口准备身份与能力。
//!
//! 插件界面是插件作者自己写的网页，宿主通过 `plugin` 自定义协议把这些文件喂给插件
//! 窗口（见 [`protocol`]），因此这里没有「加载插件代码」这一步——宿主从不执行插件
//! 的逻辑，只负责把它的页面交出去、并在它回来调能力时判断该不该给。
//!
//! # 能力判定的两个前提
//!
//! 五条能力命令的入口都做两件事，缺一不可：
//!
//! 1. **身份取自调用方窗口标签**，而不是命令参数里的 `plugin_id`（见
//!    [`resolve_caller_plugin_id`]）。参数是插件自己填的，采纳它等于让插件 A 声明成 B。
//! 2. **权限取自该插件的清单**（见 [`require_permission`]）。ACL 的粒度是窗口、清单的
//!    粒度是插件，两者对不上，所以「这个插件有没有声明这条能力」只能在这里判。
//!
//! 宿主自己的审计日志走 [`append_log`]，**不再要求插件声明 `log:write`**：那是宿主在
//! 记账，不是插件在调能力，要求声明会把「能上网」和「能写日志」这两件事绑在一起。
//!
//! 插件窗口开多大由 [`window_preference`] 决定：它是「用户记住的尺寸 > 清单声明 >
//! 全局默认」三级优先级的唯一实现处，并且在窗口关闭时把最后尺寸写回 SQLite。

mod bridge;
mod hotkey;
mod protocol;
mod window_preference;

pub use hotkey::{
    list_plugin_hotkeys, register_all_plugin_hotkeys, set_plugin_hotkey, PluginHotkeyRegistration,
};
pub use protocol::handle_plugin_asset_request;

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::domain::plugin::{
    PluginHttpRequest, PluginHttpResponse, PluginManifest, PluginScanResult,
    PLUGIN_CLIPBOARD_MAX_BYTES, PLUGIN_LOG_DIR_NAME, PLUGIN_NOTIFICATION_EVENT, PLUGIN_PERMISSIONS,
    PLUGIN_PERMISSION_CLIPBOARD_READ, PLUGIN_PERMISSION_CLIPBOARD_WRITE, PLUGIN_PERMISSION_FS_READ,
    PLUGIN_PERMISSION_FS_WRITE, PLUGIN_PERMISSION_LOG_WRITE, PLUGIN_PERMISSION_NET_REQUEST,
    PLUGIN_PERMISSION_UI_NOTIFY, PLUGIN_PROTOCOL_SCHEME, PLUGIN_ROOT_DIR_NAME,
    PLUGIN_WINDOW_LABEL_PREFIX, PLUGIN_WINDOW_MIN_SIZE,
};
use crate::infrastructure::filesystem::{plugin_log, plugin_package};
use crate::infrastructure::http;
use crate::infrastructure::windows::shell_file;
use crate::infrastructure::windows::text_clipboard;

/// 宿主转发给界面的插件通知载荷。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginNotificationPayload {
    /// 通知来源插件 id，界面据此标注发起方。
    pub plugin_id: String,
    /// 通知标题。
    pub title: String,
    /// 通知正文。
    pub message: String,
    /// 通知产生时间（毫秒时间戳），界面按此排序并做去重展示。
    pub created_at: u64,
}

/// 扫描全部插件包，并给每个包算好它的生效窗口尺寸。
///
/// 首次运行时插件根目录不存在会先被创建并补写内置示例包，让「插件」设置页在全新安装后
/// 就有可展示的内容，而不是一个空目录加一句无从下手的提示。
///
/// 尺寸要在这里一并返回而不是让前端自己算：已知来源有三处（插件级记录、清单声明、全局
/// 默认），而前两处只有宿主拿得到（一个在 SQLite，一个在清单里，前端读清单要走额外命令）。
pub async fn scan_plugin_packages(app: &AppHandle) -> Result<PluginScanResult, String> {
    let root = resolve_plugin_root(app)?;
    plugin_package::seed_sample_package_if_empty(&root)?;

    let mut result = plugin_package::scan_packages(&root)?;

    for package in &mut result.packages {
        package.window_size =
            window_preference::resolve_window_size(app, &package.id, package.manifest.as_ref())
                .await;

        // 图标地址在这里一次性算好：协议前缀随平台变化（Windows 是 http，其它平台是
        // plugin://），前端不允许自己拼。声明路径经过扫描期校验，地址构造只剩「拼字符串」
        // 这一步，理论上不会失败；若真失败按「未声明图标」处理，让面板回退占位图。
        package.icon_url = package
            .manifest
            .as_ref()
            .and_then(|manifest| manifest.icon.as_deref())
            .and_then(|icon| resolve_asset_url(&package.id, icon.trim()).ok())
            .map(|url| url.to_string());
    }

    Ok(result)
}

/// 插件页面资源的 URL 前缀，按平台给出。
///
/// WebView 对自定义协议的寻址方式并不跨平台一致：Windows（WebView2）与 Android 把它
/// 映射成 `http://<scheme>.localhost`，其余平台是 `<scheme>://localhost`。这条判断只在
/// 这里存在一份，页面地址由 [`resolve_page_url`] 直接给出完整结果，前端不重复实现。
pub fn asset_base_url() -> String {
    if cfg!(any(windows, target_os = "android")) {
        format!("http://{PLUGIN_PROTOCOL_SCHEME}.localhost")
    } else {
        format!("{PLUGIN_PROTOCOL_SCHEME}://localhost")
    }
}

/// 把「调用方窗口」与「插件自报的 id」收敛成可信的插件 id。
///
/// 插件窗口的标签是 `plugin_<id>`，由宿主在建窗时写死，插件页面改不了它（改标签要
/// `core:window` 权限，而插件窗口一条 Tauri 权限都没有）。标签形如 `plugin_` 就一律
/// 以标签为准，**忽略插件传来的 id**；不是插件窗口（宿主自己的窗口）时才采纳参数。
///
/// 这条规则换来了一个不变量：**插件只能以自己的身份调能力**。没有它，插件在页面里
/// 传一个别人的 id 就能读写别人的包内文件、以别人的名义发网络请求和通知。
pub fn resolve_caller_plugin_id(window_label: &str, claimed_plugin_id: &str) -> String {
    window_label
        .strip_prefix(PLUGIN_WINDOW_LABEL_PREFIX)
        .map(str::to_string)
        .unwrap_or_else(|| claimed_plugin_id.to_string())
}

/// 为插件开一个界面窗口；窗口已存在时只把它调到前台。
///
/// 建窗放在 Rust 侧而不是前端，原因是**能力桥只能在建窗时注入**：Tauri 的前端窗口选项
/// 不透出初始化脚本，而 `window.dasktop` 必须在插件自己的脚本执行之前就绪。顺带把
/// 「已存在就聚焦」的判断也收到一处，不会出现前后端各判一次还不一致。
///
/// # 为什么必须 `async`（别改回同步）
///
/// 同步命令是在 **主线程** 上就地执行的：WebView2 的 IPC 回调本身跑在 UI 线程，而 Tauri
/// 注册的 handler 只是直接调用命令（`tauri-runtime-wry/src/lib.rs::create_ipc_handler`），
/// 不换线程。而 `create_window` 判断到「当前就是主线程」后会**忽略事件循环代理、就地执行**
/// 建窗（同文件 `send_user_message`）。于是同步命令里的 `.build()` 变成「在 WebView2 的
/// `WebMessageReceived` 回调里同步创建第二个 WebView2 controller」——它要等消息循环转起来
/// 才能完成初始化，而消息循环正卡在这个回调里出不去：**主线程死锁**。
///
/// 症状正是「宿主界面卡住 + 插件窗口一片空白」（原生窗口已建出来，WebView2 却没初始化完）。
/// 写成 `async fn` 后，Tauri 的命令宏走 `InvokeResolver::respond_async` →
/// `async_runtime::spawn`，落到 tokio 多线程运行时的 worker 线程上，`send_user_message`
/// 走事件循环代理，建窗由主线程在事件循环里正常完成。Tauri 自己的 `plugin:window|create`
/// 也是 `async` 的，同一个原因。
pub async fn open_plugin_window(
    app: &AppHandle,
    plugin_id: &str,
    trigger: Option<&str>,
) -> Result<(), String> {
    if !plugin_package::is_valid_plugin_id(plugin_id) {
        return Err(format!("非法插件 id：{plugin_id}"));
    }

    let label = format!("{PLUGIN_WINDOW_LABEL_PREFIX}{plugin_id}");

    // 已存在时不重新导航：用户在插件页面里可能已经翻到第二页，重载会把他弹回入口。
    if let Some(existing) = app.get_webview_window(&label) {
        // 先还原再显示：上次可能是被最小化关掉的，只 show 会留下一个不可见的窗口，
        // 用户点「打开」看起来毫无反应。
        existing
            .unminimize()
            .map_err(|error| format!("插件窗口还原失败：{error}"))?;
        existing
            .show()
            .map_err(|error| format!("插件窗口显示失败：{error}"))?;

        return existing
            .set_focus()
            .map_err(|error| format!("插件窗口聚焦失败：{error}"));
    }

    let package_dir = resolve_package_dir(app, plugin_id)?;
    let manifest = plugin_package::read_manifest(&package_dir)?;

    ensure_known_permissions(plugin_id, &manifest)?;
    ensure_entry_page(&package_dir, &manifest)?;

    // 尺寸在开窗前一次性定下来：窗口已经存在时不重新设置大小——用户在插件页面里可能
    // 已经拖着自己要的尺寸，重载他调整过的值只会让人以为「拖了没记住」。
    let window_size = window_preference::resolve_window_size(app, plugin_id, Some(&manifest)).await;

    // 标准插件窗口沿用全局最小尺寸下限；下限与 contract.rs 的 PLUGIN_WINDOW_MIN_SIZE 保持一致，
    // 否则 WebView 会把低于下限的窗口自行拉回下限，「设了 200×200 读回来却是下限」就源于两处不一致。
    let min_size = PLUGIN_WINDOW_MIN_SIZE;

    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        &label,
        resolve_webview_target(plugin_id, &manifest.entry)?,
    )
    .title(format!("{} - Dasktop 插件", manifest.name))
    .inner_size(window_size.width, window_size.height)
    .min_inner_size(min_size.0, min_size.1)
    // 先隐藏再居中：build 出来的瞬间窗口默认可见，会先在默认位置闪一下再被 center 挪走，
    // 因此建窗时保持不可见，居中完成后再 show，避免「先闪一下再复位」。
    .visible(false)
    .initialization_script(bridge::build_script(plugin_id, &manifest)?);

    // 被热键唤起且首次建窗时，把「被唤起」意图注入页面：插件页面加载后通过
    // dasktop.hotkey.onTrigger 读走这个意图，而不必等宿主发事件（页面还没挂监听时事件必丢）。
    if trigger.is_some() {
        builder =
            builder.initialization_script("window.__DASKTOP_HOTKEY_INTENT__ = true;".to_string());
    }

    let window = builder
        .build()
        .map_err(|error| format!("插件窗口创建失败：{error}"))?;

    // 位置不记忆：每次新建都居中显示在屏幕中间，而非沿用上次拖到的位置。
    // 已存在窗口的重新打开走上面那条早退分支，保持当前位置不被弹回。
    if let Err(error) = window.center() {
        eprintln!("[plugin] 居中插件 {plugin_id} 窗口失败：{error}");
    }

    window
        .show()
        .map_err(|error| format!("插件窗口显示失败：{error}"))?;

    window
        .set_focus()
        .map_err(|error| format!("插件窗口聚焦失败：{error}"))?;

    Ok(())
}

/// 读取插件包内文本文件，对应 `fs:read` 能力。
pub fn read_plugin_file(
    app: &AppHandle,
    plugin_id: &str,
    relative_path: &str,
) -> Result<String, String> {
    require_permission(app, plugin_id, PLUGIN_PERMISSION_FS_READ)?;

    let package_dir = resolve_package_dir(app, plugin_id)?;

    plugin_package::read_package_file(&package_dir, relative_path)
}

/// 写入插件包内文本文件，对应 `fs:write` 能力。
pub fn write_plugin_file(
    app: &AppHandle,
    plugin_id: &str,
    relative_path: &str,
    contents: &str,
) -> Result<(), String> {
    require_permission(app, plugin_id, PLUGIN_PERMISSION_FS_WRITE)?;

    let package_dir = resolve_package_dir(app, plugin_id)?;

    plugin_package::write_package_file(&package_dir, relative_path, contents)
}

/// 追加插件运行日志，对应 `log:write` 能力。
pub fn write_plugin_log(
    app: &AppHandle,
    plugin_id: &str,
    level: &str,
    message: &str,
) -> Result<(), String> {
    require_permission(app, plugin_id, PLUGIN_PERMISSION_LOG_WRITE)?;

    append_log(app, plugin_id, level, message)
}

/// 发送宿主通知，对应 `ui:notify` 能力。
///
/// 通知同时落日志：宿主界面不可见时（例如自启静默驻留托盘期间）事件没有订阅者，
/// 此时日志是唯一能回溯插件行为的通道。这一行日志走 [`append_log`]，不需要插件
/// 额外声明 `log:write`——那是宿主为这次通知留的凭据。
pub fn notify_from_plugin(
    app: &AppHandle,
    plugin_id: &str,
    title: &str,
    message: &str,
) -> Result<(), String> {
    require_permission(app, plugin_id, PLUGIN_PERMISSION_UI_NOTIFY)?;

    append_log(app, plugin_id, "notify", &format!("{title}：{message}"))?;

    let payload = PluginNotificationPayload {
        plugin_id: plugin_id.to_string(),
        title: title.to_string(),
        message: message.to_string(),
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or_default(),
    };

    app.emit(PLUGIN_NOTIFICATION_EVENT, payload)
        .map_err(|error| format!("插件通知广播失败：{error}"))
}

/// 读取系统剪贴板文本，对应 `clipboard:read` 能力。
///
/// 只记录字符数：剪贴板内容可能含密码等敏感信息，绝不写进日志。
/// 超长文本按 UTF-8 字符边界截断到 [`PLUGIN_CLIPBOARD_MAX_BYTES`]，防止超大内容拖垮 IPC。
pub fn read_clipboard_text(app: &AppHandle, plugin_id: &str) -> Result<String, String> {
    require_permission(app, plugin_id, PLUGIN_PERMISSION_CLIPBOARD_READ)?;

    let text = text_clipboard::read_text()?.unwrap_or_default();
    let truncated = truncate_utf8_boundary(&text, PLUGIN_CLIPBOARD_MAX_BYTES);

    append_log(
        app,
        plugin_id,
        "clipboard",
        &format!("读取剪贴板文本，{} 字符", truncated.chars().count()),
    )?;

    Ok(truncated)
}

/// 写入系统剪贴板文本，对应 `clipboard:write` 能力。
///
/// 只记录字符数：剪贴板内容可能含密码等敏感信息，绝不写进日志。
pub fn write_clipboard_text(app: &AppHandle, plugin_id: &str, text: &str) -> Result<(), String> {
    require_permission(app, plugin_id, PLUGIN_PERMISSION_CLIPBOARD_WRITE)?;

    if text.len() > PLUGIN_CLIPBOARD_MAX_BYTES {
        return Err(format!(
            "剪贴板文本超出上限（{PLUGIN_CLIPBOARD_MAX_BYTES} 字节）"
        ));
    }

    text_clipboard::write_text(text)?;

    append_log(
        app,
        plugin_id,
        "clipboard",
        &format!("写入剪贴板文本，{} 字符", text.chars().count()),
    )
}

/// 代表插件发起 HTTP 请求，对应 `net:request` 能力。
///
/// 发起与完成各记一行日志：网络能力是插件里最难复现的一类行为，出问题时
/// 「发过哪些请求、最终什么状态」往往比插件自己的报错更有定位价值。
/// 失败路径只留下「发起」那一行，正好说明请求没有拿到响应。
pub async fn http_request(
    app: &AppHandle,
    plugin_id: &str,
    request: PluginHttpRequest,
) -> Result<PluginHttpResponse, String> {
    require_permission(app, plugin_id, PLUGIN_PERMISSION_NET_REQUEST)?;

    let method = request
        .method
        .as_deref()
        .map(|value| value.trim().to_ascii_uppercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "GET".to_string());

    append_log(app, plugin_id, "net", &format!("{method} {}", request.url))?;

    let response = http::send(&request).await?;

    append_log(
        app,
        plugin_id,
        "net",
        &format!("{method} {} -> {}", request.url, response.status),
    )?;

    Ok(response)
}

/// 按 UTF-8 字符边界截断字符串到指定字节上限。
///
/// 直接用 `String::truncate` 可能切在多字节字符中间导致 panic，这里先扫描
/// 字符边界找到安全截断点。
fn truncate_utf8_boundary(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }

    let mut boundary = 0;
    for (index, _) in text.char_indices() {
        if index > max_bytes {
            break;
        }
        boundary = index;
    }

    text[..boundary].to_string()
}

/// 用系统资源管理器打开插件根目录，方便用户手工安装或替换插件包。
pub fn open_plugin_root(app: &AppHandle) -> Result<(), String> {
    let root = resolve_plugin_root(app)?;
    plugin_package::ensure_root(&root)?;

    shell_file::open_folder_in_explorer(&root.to_string_lossy())
}

/// 同步源目录相对 `src-tauri` 的位置，也就是仓库根目录下的 `plugins/`。
const DEV_PLUGIN_SOURCE_SUBDIR: &str = "../plugins";

/// 把仓库里的插件包同步到插件根目录，返回本次同步的包 id。
///
/// **这是开发调试用的命令，不是给用户的功能**：源目录靠 `CARGO_MANIFEST_DIR` 在编译期定位，
/// 拿到的是构建机器上的源码目录。开发时它确实指向本地仓库，所以「改完插件源码点一下按钮」
/// 就能生效——不需要重新编译，也不用手工复制目录。
///
/// 反过来，打包后的应用里这个路径通常不存在，命令会返回明确错误而不是静默失败。这条命令
/// 刻意不做「源码不在就用内嵌示例包代替」的兜底：那会把「我改的文件没生效」伪装成
/// 「同步成功了」，而调试按钮最不能骗的就是这一点。
pub fn sync_dev_plugin_packages(app: &AppHandle) -> Result<Vec<String>, String> {
    let source_root = Path::new(env!("CARGO_MANIFEST_DIR")).join(DEV_PLUGIN_SOURCE_SUBDIR);
    let target_root = resolve_plugin_root(app)?;

    plugin_package::sync_packages_from_source(&source_root, &target_root)
}

/* -------------------------------------------------------------------------- */
/* 能力判定                                                                    */
/* -------------------------------------------------------------------------- */

/// 确认插件清单声明了某项能力。
///
/// 这条判定不能在别处替代：capability 是按**窗口**授权的，而清单权限是按**插件**声明
/// 的。插件窗口那一份 capability 只能把五条能力命令整体授予「所有插件窗口」，所以
/// 「具体这个插件有没有声明」只有读到它的清单才知道。
///
/// 每次都重读清单而不是缓存：插件是磁盘上的目录，作者改完清单再点「重新加载」就该
/// 生效；缓存会让「改了没反应」变成一个需要排查的问题，而重读的代价只是一次小文件读取。
fn require_permission(app: &AppHandle, plugin_id: &str, permission: &str) -> Result<(), String> {
    let package_dir = resolve_package_dir(app, plugin_id)?;
    let manifest = plugin_package::read_manifest(&package_dir)?;

    if manifest
        .permissions
        .iter()
        .any(|declared| declared == permission)
    {
        return Ok(());
    }

    Err(format!(
        "插件 {plugin_id} 未声明能力 {permission}：需要在它的插件包目录下 plugin.json 的 permissions 里加上这一项"
    ))
}

/// 确认清单里没有宿主不认识的能力。
///
/// 与前端加载器是同一条规则，但**必须也在这里判一遍**：窗口是命令直接开的，只在前端
/// 拦的话这条规则可以被绕过，而绕过的后果是桥按一份不完整的权限集合挂载——某个能力
/// 静默不出现，作者只会以为宿主坏了。
fn ensure_known_permissions(plugin_id: &str, manifest: &PluginManifest) -> Result<(), String> {
    let unknown: Vec<&str> = manifest
        .permissions
        .iter()
        .map(String::as_str)
        .filter(|permission| !PLUGIN_PERMISSIONS.contains(permission))
        .collect();

    if unknown.is_empty() {
        return Ok(());
    }

    Err(format!(
        "插件 {plugin_id} 声明了宿主不认识的能力：{}",
        unknown.join("、")
    ))
}

/// 确认入口页面真实存在。
///
/// 扫描期已经查过一次，但那个结果只存在于前端快照里；从「扫描过」到「用户点开」之间，
/// 作者完全可能把文件挪走。这里失败会直接给出文件名，而少了这一步用户看到的是一片空白。
fn ensure_entry_page(
    package_dir: &std::path::Path,
    manifest: &PluginManifest,
) -> Result<(), String> {
    match plugin_package::resolve_sandboxed_path(package_dir, &manifest.entry) {
        Ok(path) if path.is_file() => Ok(()),
        Ok(_) => Err(format!("入口页面不存在：{}", manifest.entry)),
        Err(message) => Err(format!("入口页面路径非法：{}（{message}）", manifest.entry)),
    }
}

/* -------------------------------------------------------------------------- */
/* 页面地址                                                                    */
/* -------------------------------------------------------------------------- */

/// 拼出插件入口页面的地址，并决定该用哪种 `WebviewUrl`。
///
/// 平台差异体现在 scheme 上：Windows 上自定义协议被映射成 `http`，其它平台是
/// `plugin://`。这两种必须走 `WebviewUrl` 的不同分支——`External` 只接受 http/https，
/// 拿 `plugin://` 去构造它会得到与预期不符的结果。
fn resolve_webview_target(plugin_id: &str, entry: &str) -> Result<tauri::WebviewUrl, String> {
    let url = resolve_asset_url(plugin_id, entry)?;

    Ok(if matches!(url.scheme(), "http" | "https") {
        tauri::WebviewUrl::External(url)
    } else {
        tauri::WebviewUrl::CustomProtocol(url)
    })
}

/// 拼出插件包内任意资源（入口页面、图标等）的完整协议地址。
///
/// 这是插件资源 URL 的**唯一构造处**：开窗时的入口地址与扫描结果里下发给面板的
/// `iconUrl` 都从这里走，保证两条链拼出的地址形状一致、都能被 [`protocol`] 处理器
/// 解读回来。
fn resolve_asset_url(plugin_id: &str, asset_path: &str) -> Result<tauri::Url, String> {
    let mut url: tauri::Url = asset_base_url()
        .parse()
        .map_err(|error| format!("插件页面地址前缀无法解析：{error}"))?;

    url.set_path(&encode_asset_path(plugin_id, asset_path));

    Ok(url)
}

/// 把插件 id 与资源路径编码成 URL 路径。
///
/// 必须是**多段**形式，不能图省事把整串路径塞进一段：页面里的相对链接
/// （`./history.html`）是相对当前路径的目录解析的，压成一段之后它会丢掉插件 id，
/// 协议处理器就再也定位不到包目录。这也是为什么不用 Tauri 的 `convertFileSrc` ——
/// 它对整串做 `encodeURIComponent`，`/` 会一起变成 `%2F`。
fn encode_asset_path(plugin_id: &str, asset_path: &str) -> String {
    let mut path = String::with_capacity(plugin_id.len() + asset_path.len() + 2);
    path.push('/');
    path.push_str(plugin_id);

    for segment in asset_path
        .split('/')
        .filter(|segment| !segment.is_empty())
    {
        path.push('/');
        // `Url::set_path` 不编码 `%`，而路径里一个裸 `%` 就是非法转义序列
        // （文件名写成 `100%.html` 就够了，WebView 可能整条地址都不认）。
        path.push_str(&segment.replace('%', "%25"));
    }

    path
}

/* -------------------------------------------------------------------------- */
/* 内部实现                                                                    */
/* -------------------------------------------------------------------------- */

/// 落一行插件日志，不做权限判定。
///
/// 供宿主自己的记账使用（网络请求的前后记录、通知的凭据）。插件主动调 `log:write`
/// 走的是 [`write_plugin_log`]，那里会校验清单。
fn append_log(app: &AppHandle, plugin_id: &str, level: &str, message: &str) -> Result<(), String> {
    // id 必须过白名单校验——它直接参与日志文件名拼接。
    if !plugin_package::is_valid_plugin_id(plugin_id) {
        return Err(format!("非法插件 id：{plugin_id}"));
    }

    let log_dir = resolve_log_dir(app)?;

    plugin_log::append_log(&log_dir, plugin_id, level, message)
}

/// 解析插件根目录路径；只计算路径，不保证目录已经存在。
fn resolve_plugin_root(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法解析应用数据目录：{error}"))?;

    Ok(data_dir.join(PLUGIN_ROOT_DIR_NAME))
}

/// 解析插件日志目录路径。
fn resolve_log_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法解析应用数据目录：{error}"))?;

    Ok(data_dir.join(PLUGIN_LOG_DIR_NAME))
}

/// 定位插件包目录，同时挡住非法 id 用路径分隔符越权。
fn resolve_package_dir(app: &AppHandle, plugin_id: &str) -> Result<PathBuf, String> {
    let root = resolve_plugin_root(app)?;

    plugin_package::resolve_package_dir(&root, plugin_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_label_wins_over_claimed_id() {
        // 插件窗口里传来的 id 一律不采纳：那是插件自己填的，采纳它等于让插件 A
        // 声明成 B 去读写 B 的包内文件。
        assert_eq!(
            resolve_caller_plugin_id("plugin_http-console", "hello-dasktop"),
            "http-console"
        );
    }

    #[test]
    fn host_windows_keep_the_argument() {
        // 宿主自己的窗口没有插件身份，只能采纳参数（宿主代码是可信的）。
        assert_eq!(
            resolve_caller_plugin_id("main", "http-console"),
            "http-console"
        );
        assert_eq!(
            resolve_caller_plugin_id("box_a1b2c3", "hello-dasktop"),
            "hello-dasktop"
        );
    }

    #[test]
    fn label_prefix_is_stripped_only_once() {
        // 插件 id 本身允许下划线，`plugin_plugin_x` 必须解析回 `plugin_x`。
        assert_eq!(
            resolve_caller_plugin_id("plugin_plugin_x", "ignored"),
            "plugin_x"
        );
    }

    #[test]
    fn asset_path_stays_multi_segment() {
        // 压成一段会让页面里的相对链接丢掉插件 id，协议处理器就定位不到包目录。
        assert_eq!(
            encode_asset_path("http-console", "index.html"),
            "/http-console/index.html"
        );
        assert_eq!(
            encode_asset_path("http-console", "pages/history.html"),
            "/http-console/pages/history.html"
        );
    }

    #[test]
    fn asset_path_encodes_each_segment_separately() {
        // 段落里的空格与中文交给 `set_path` 编码，但 `/` 必须保持为分隔符。
        let url = resolve_asset_url("demo", "子目录/说明.html").expect("地址应可构造");

        assert_eq!(
            url.path(),
            "/demo/%E5%AD%90%E7%9B%AE%E5%BD%95/%E8%AF%B4%E6%98%8E.html"
        );
    }

    #[test]
    fn icon_url_points_into_the_same_package_origin() {
        // 面板把这条地址直接放进 <img src>：它必须与页面同源、路径首段是插件 id，
        // 资源协议处理器才能按既有的包目录定位规则读出图标。
        let url = resolve_asset_url("hello-dasktop", "assets/icon.svg")
            .expect("图标地址应可构造");

        assert_eq!(url.path(), "/hello-dasktop/assets/icon.svg");
        assert_eq!(url.scheme(), asset_base_url_scheme());
    }

    /// 当前平台资源地址应使用的 scheme，供测试只比对 scheme 而不硬编码平台前缀。
    fn asset_base_url_scheme() -> &'static str {
        if cfg!(any(windows, target_os = "android")) {
            "http"
        } else {
            "plugin"
        }
    }

    #[test]
    fn asset_path_escapes_bare_percent() {
        // `set_path` 不编码 `%`，裸 `%` 会让整条地址变成非法转义序列。
        let url = resolve_asset_url("demo", "100%.html").expect("地址应可构造");

        assert_eq!(url.path(), "/demo/100%25.html");
    }

    #[test]
    fn page_target_follows_platform_scheme() {
        // Windows 上自定义协议被映射成 http，必须走 External；其它平台是
        // `plugin://`，必须走 CustomProtocol。两条分支都用真实前缀验证一遍。
        let target = resolve_webview_target("demo", "index.html").expect("目标应可构造");

        if cfg!(any(windows, target_os = "android")) {
            assert!(matches!(target, tauri::WebviewUrl::External(_)));
        } else {
            assert!(matches!(target, tauri::WebviewUrl::CustomProtocol(_)));
        }
    }
}
