//! 插件命令层。
//!
//! 只做 IPC 参数接收与转发。
//!
//! 十条能力命令都带一个 `window: tauri::Window` 参数，这不是为了操作窗口，而是为了拿到
//! **调用方身份**：插件窗口的标签是 `plugin_<id>`，由宿主建窗时写死，插件页面改不了。
//! 命令参数里的 `plugin_id` 则完全由插件填写，只作为宿主窗口调用时的兜底。两者交给
//! [`plugin::resolve_caller_plugin_id`] 收敛，结果是「插件只能以自己的身份调能力」。
//!
//! 权限判定不在这里，而在服务层：ACL 的粒度是窗口、清单的粒度是插件，命令层拿不到
//! 「这个插件声明了什么」这个信息，只能读清单，那属于服务层的编排职责。

use tauri::{AppHandle, Window};

use crate::domain::plugin::{PluginHttpRequest, PluginHttpResponse, PluginScanResult};
use crate::services::plugin;

/// 扫描插件根目录，返回全部插件包的清单、解析失败原因与各自的生效窗口尺寸。
///
/// 首次调用会创建插件根目录并在其为空时写入内置示例包。
///
/// **声明为 `async` 是因为扫描要读 SQLite**：每个插件的生效尺寸来自数据库里的插件级
/// 记录与全局默认设置，读库是异步的，同步命令里没有可 await 的上下文。
#[tauri::command]
pub async fn list_plugins(app: AppHandle) -> Result<PluginScanResult, String> {
    let result = plugin::scan_plugin_packages(&app).await?;

    // 扫描即「重载」：每重载一次就把最新启动热键重新挂到系统，改键后也能即时生效。
    // 注册层每次全量重挂（先注销再注册），幂等，重复触发无害。
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = plugin::register_all_plugin_hotkeys(&handle).await {
            eprintln!("[plugin] 重载后注册热键失败：{error}");
        }
    });

    Ok(result)
}

/// 打开插件的界面窗口；窗口已存在时只把它调到前台。
///
/// 建窗在 Rust 侧完成，因为能力桥只能随建窗注入（前端窗口选项不透出初始化脚本）。
///
/// **必须声明为 `async`**：同步命令在主线程上执行，而在主线程里建 WebView2 会死锁
/// （完整推导见 [`plugin::open_plugin_window`]）。这里不是「顺手写成异步」，
/// 改成同步会让插件窗口打不开、宿主界面一起卡死。
///
/// `trigger` 携带「被启动热键唤起」的意图（来自全局快捷键回调）；普通从设置页点开时
/// 为 `None`。它只影响首次建窗时是否向页面注入唤起意图，不改变建窗结果。
#[tauri::command]
pub async fn open_plugin_window(
    app: AppHandle,
    plugin_id: String,
    trigger: Option<String>,
) -> Result<(), String> {
    plugin::open_plugin_window(&app, &plugin_id, trigger.as_deref()).await
}

/// 列出全部插件热键的注册状态，叠加用户覆盖并标注冲突 / 非法。
///
/// 设置页据此集中展示「哪些插件挂了快捷键」并允许用户禁用或改键。真正把快捷键挂到
/// 系统上由注册层完成，本命令只负责把清单、覆盖与状态算清楚。
#[tauri::command]
pub async fn list_plugin_hotkeys(
    app: AppHandle,
) -> Result<Vec<plugin::PluginHotkeyRegistration>, String> {
    plugin::list_plugin_hotkeys(&app).await
}

/// 写入或更新某插件的启动热键配置（生效快捷键 + 是否启用）。
///
/// 配置指向真实安装的插件；禁用或清空快捷键时不需要先填合法快捷键。
#[tauri::command]
pub async fn set_plugin_hotkey(
    app: AppHandle,
    plugin_id: String,
    accelerator: String,
    enabled: bool,
) -> Result<(), String> {
    plugin::set_plugin_hotkey(&app, &plugin_id, &accelerator, enabled).await
}

/// 读取插件包内文本文件，对应 `fs:read` 能力。
#[tauri::command]
pub fn read_plugin_package_file(
    app: AppHandle,
    window: Window,
    plugin_id: String,
    relative_path: String,
) -> Result<String, String> {
    let plugin_id = plugin::resolve_caller_plugin_id(window.label(), &plugin_id);

    plugin::read_plugin_file(&app, &plugin_id, &relative_path)
}

/// 写入插件包内文本文件，对应 `fs:write` 能力。
#[tauri::command]
pub fn write_plugin_package_file(
    app: AppHandle,
    window: Window,
    plugin_id: String,
    relative_path: String,
    contents: String,
) -> Result<(), String> {
    let plugin_id = plugin::resolve_caller_plugin_id(window.label(), &plugin_id);

    plugin::write_plugin_file(&app, &plugin_id, &relative_path, &contents)
}

/// 弹出系统保存对话框，把插件提交的内容写到用户选定的路径，对应 `fs:save` 能力。
///
/// 返回落盘后的完整路径；用户取消对话框时返回 `None`。插件要靠这个返回值把「文件到底
/// 存到哪了」告诉用户——桌面上只说一句「已保存」而不给位置，等于没说。
///
/// `contents` 是 base64 载荷（不含 data URL 前缀）：图片这类二进制只能以文本跨 IPC，
/// 文本文件套用同一种载荷，插件端就不必为不同内容类型准备两条调用路径。
///
/// 与 [`choose_collection_root_folder`] 一样是同步命令：`IFileDialog::Show` 在带 owner
/// 句柄时会跑自己的模态消息循环，阻塞的是调用线程而不是界面，因此不需要 async。
#[tauri::command]
pub fn save_plugin_file(
    app: AppHandle,
    window: Window,
    plugin_id: String,
    file_name: String,
    contents: String,
) -> Result<Option<String>, String> {
    let plugin_id = plugin::resolve_caller_plugin_id(window.label(), &plugin_id);

    #[cfg(target_os = "windows")]
    {
        let owner = window
            .hwnd()
            .map_err(|error| format!("无法获取插件窗口句柄：{error}"))?;

        plugin::save_file_with_dialog(&app, &plugin_id, owner, &file_name, &contents)
    }

    #[cfg(not(target_os = "windows"))]
    {
        plugin::save_file_with_dialog(&app, &plugin_id, (), &file_name, &contents)
    }
}

/// 追加插件运行日志，对应 `log:write` 能力。
#[tauri::command]
pub fn write_plugin_log(
    app: AppHandle,
    window: Window,
    plugin_id: String,
    level: String,
    message: String,
) -> Result<(), String> {
    let plugin_id = plugin::resolve_caller_plugin_id(window.label(), &plugin_id);

    plugin::write_plugin_log(&app, &plugin_id, &level, &message)
}

/// 发送宿主通知，对应 `ui:notify` 能力。
#[tauri::command]
pub fn notify_from_plugin(
    app: AppHandle,
    window: Window,
    plugin_id: String,
    title: String,
    message: String,
) -> Result<(), String> {
    let plugin_id = plugin::resolve_caller_plugin_id(window.label(), &plugin_id);

    plugin::notify_from_plugin(&app, &plugin_id, &title, &message)
}

/// 读取系统剪贴板文本，对应 `clipboard:read` 能力。
#[tauri::command]
pub fn read_plugin_clipboard_text(
    app: AppHandle,
    window: Window,
    plugin_id: String,
) -> Result<String, String> {
    let plugin_id = plugin::resolve_caller_plugin_id(window.label(), &plugin_id);

    plugin::read_clipboard_text(&app, &plugin_id)
}

/// 读取系统剪贴板中的图片（data URL），对应 `clipboard:read` 能力。
///
/// 与文本读取共用 `clipboard:read` 权限：对插件而言这是同一种能力，文本还是图片只是
/// 运行时内容上的差别，不该要求插件为此多声明一条权限。
///
/// 剪贴板里没有图片时返回 `None`，让插件自己决定提示文案——「复制的是文本」是正常
/// 操作，不是能力失败。
#[tauri::command]
pub fn read_plugin_clipboard_image(
    app: AppHandle,
    window: Window,
    plugin_id: String,
) -> Result<Option<String>, String> {
    let plugin_id = plugin::resolve_caller_plugin_id(window.label(), &plugin_id);

    plugin::read_clipboard_image(&app, &plugin_id)
}

/// 写入系统剪贴板文本，对应 `clipboard:write` 能力。
#[tauri::command]
pub fn write_plugin_clipboard_text(
    app: AppHandle,
    window: Window,
    plugin_id: String,
    text: String,
) -> Result<(), String> {
    let plugin_id = plugin::resolve_caller_plugin_id(window.label(), &plugin_id);

    plugin::write_clipboard_text(&app, &plugin_id, &text)
}

/// 写入系统剪贴板图片（PNG base64 载荷），对应 `clipboard:write` 能力。
///
/// 与文本写入共用 `clipboard:write` 权限：对插件而言这是同一种能力，文本还是图片只是
/// 运行时内容上的差别，不该要求插件为此多声明一条权限。
///
/// `image` 是不含 data URL 前缀的 base64 载荷：二进制只能以文本跨 IPC。宿主解码后以
/// CF_DIB 写入系统剪贴板，Windows 会自动合成 CF_BITMAP 供其它应用粘贴。
#[tauri::command]
pub fn write_plugin_clipboard_image(
    app: AppHandle,
    window: Window,
    plugin_id: String,
    image: String,
) -> Result<(), String> {
    let plugin_id = plugin::resolve_caller_plugin_id(window.label(), &plugin_id);

    plugin::write_clipboard_image(&app, &plugin_id, &image)
}

/// 代表插件发起 HTTP 请求，对应 `net:request` 能力。
///
/// 刻意声明为异步：请求耗时完全取决于远端，同步命令会让整条 IPC 通道一起等待。
#[tauri::command]
pub async fn plugin_http_request(
    app: AppHandle,
    window: Window,
    plugin_id: String,
    request: PluginHttpRequest,
) -> Result<PluginHttpResponse, String> {
    let plugin_id = plugin::resolve_caller_plugin_id(window.label(), &plugin_id);

    plugin::http_request(&app, &plugin_id, request).await
}

/// 用系统资源管理器打开插件根目录，供用户手工安装插件包。
#[tauri::command]
pub fn open_plugin_root(app: AppHandle) -> Result<(), String> {
    plugin::open_plugin_root(&app)
}

/// 把仓库里的插件包同步到插件根目录（开发调试用），返回本次同步的包 id。
///
/// 界面入口是设置页「插件」面板里插件目录那一行的「同步」按钮。源目录由 `CARGO_MANIFEST_DIR`
/// 在编译期定位，所以这条命令只在源码目录下有意义；打包后的应用调用它会拿到明确错误。
#[tauri::command]
pub fn sync_dev_plugin_packages(app: AppHandle) -> Result<Vec<String>, String> {
    plugin::sync_dev_plugin_packages(&app)
}

/// 弹出屏幕框选层并截取用户选中的区域，对应 `screen:capture` 能力。
///
/// 返回值是选区图片的 PNG base64；用户在框选层里按 Esc / 右键取消时返回 `None`——
/// 取消是用户的正常选择而不是能力失败，插件据此区分「这次没截」与「截不到」。
///
/// **必须声明为 `async`**：命令内部会创建覆盖窗口，同步命令会在主线程上就地建窗并
/// 死锁（完整推导见 [`plugin::open_plugin_window`]）；它还要等待用户操作，同步命令
/// 会把整条 IPC 通道一起堵住。
#[tauri::command]
pub async fn capture_plugin_screen_region(
    app: AppHandle,
    window: Window,
    plugin_id: String,
) -> Result<Option<String>, String> {
    let plugin_id = plugin::resolve_caller_plugin_id(window.label(), &plugin_id);

    // 光标位置在这里读出来、`Window` 就此留在本层：后面的 await 期间不再持有窗口句柄，
    // 调用方窗口即便在等待中被关掉，也不会影响这段流程。
    let cursor = window
        .cursor_position()
        .map_err(|error| format!("读取鼠标位置失败：{error}"))?;

    plugin::capture_screen_region(&app, &plugin_id, cursor).await
}

/// 提交框选结果，由屏幕框选层在用户松开鼠标后调用。
///
/// 这条命令的调用方是宿主自己的覆盖窗口（标签 `capture_overlay`），不是插件窗口，
/// 因此这里既不做插件身份收敛，也不查插件清单——它的授权走
/// `allow-capture-overlay-commands`，见 `capabilities/capture-overlay.json`。
#[tauri::command]
pub fn finish_plugin_screen_capture(
    app: AppHandle,
    selection: plugin::ScreenCaptureSelection,
) -> Result<(), String> {
    plugin::finish_screen_capture(&app, selection)
}

/// 取消框选，由屏幕框选层在用户按 Esc / 右键时调用。
///
/// 与 [`finish_plugin_screen_capture`] 同属覆盖窗口专用的宿主命令；窗口被动关闭时
/// 服务层也会自行补一次取消，因此这里重复调用是安全的。
#[tauri::command]
pub fn cancel_plugin_screen_capture(app: AppHandle) -> Result<(), String> {
    plugin::cancel_screen_capture(&app);

    Ok(())
}
