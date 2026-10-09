//! 插件包框架的跨层契约常量。
//!
//! 目录名、清单文件名和事件名会被命令层、服务层和前端共同依赖，集中在此处声明，
//! 避免同一条约定在多处字面量里各自演进而失去同步。

/// 插件包根目录名，位于应用数据目录下；插件包按 `<root>/<plugin-id>/` 组织。
pub const PLUGIN_ROOT_DIR_NAME: &str = "plugins";

/// 插件包清单文件名，缺失即视为无效插件包。
pub const PLUGIN_MANIFEST_FILE_NAME: &str = "plugin.json";

/// 插件运行日志目录名，与插件包目录平级。
///
/// 日志刻意不写进插件包目录：插件包目录是 `fs:write` 的沙箱，宿主自己的日志写入
/// 不应污染插件作者可见的文件空间，否则插件扫描包内资源时会读到宿主日志。
pub const PLUGIN_LOG_DIR_NAME: &str = "plugin-logs";

/// 插件页面资源读取上限，单位为字节。
///
/// 插件页面是完全由作者掌控的网页，除了 HTML 还会带上它自己的脚本、样式与图片。
/// 上限比 `fs:read` 的文本读取更宽，但仍必须有：协议处理器会把整个文件读进内存
/// 再交给 WebView，一次超大资源就能把内存打满。
pub const PLUGIN_ASSET_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// 插件包内普通数据文件读取上限，单位为字节。
pub const PLUGIN_DATA_MAX_BYTES: u64 = 4 * 1024 * 1024;

/// 插件页面资源协议名。
///
/// 前端**不能**把协议写死成 `plugin://`：WebView 对自定义协议的寻址方式在各平台不同，
/// Windows（WebView2）映射为 `http://plugin.localhost/<path>`，macOS / Linux 则是
/// `plugin://localhost/<path>`。前缀一律由 `services::plugin::asset_base_url` 按平台给出。
///
/// URL 还必须写成 `/<插件id>/<相对路径>` 的**多段**形式，不能把整串路径编码成单段
/// （`encodeURIComponent` 会连 `/` 一起编码）：页面里的相对链接 `./settings.html`
/// 是相对当前路径的目录解析的，单段路径会让它丢掉插件 id，协议处理器就再也定位不到包。
pub const PLUGIN_PROTOCOL_SCHEME: &str = "plugin";

/// 单个插件日志文件的体积上限，超过后整体截断重写。
///
/// 插件与宿主同线程运行，一个 `while (true) host.log.write(...)` 就能写满磁盘，
/// 因此日志必须自带容量上限而不是只依赖插件自身克制。
pub const PLUGIN_LOG_MAX_BYTES: u64 = 512 * 1024;

/// 插件 id 最大长度；id 会参与路径拼接和日志文件名，需要在长度上设限。
pub const PLUGIN_ID_MAX_LENGTH: usize = 64;

/// 宿主向插件广播通知的事件名，前端宿主面板与插件通知出口共享同一常量。
pub const PLUGIN_NOTIFICATION_EVENT: &str = "dasktop://plugin-notification";

/// 插件窗口相对于应用窗口的尺寸与下限。
///
/// 放在领域层而不是服务层：窗口尺寸属于「插件界面长什么样」这一层次的约定，
/// 与能力判定、路径解析无关，服务层只是执行者。
pub const PLUGIN_WINDOW_SIZE: (f64, f64) = (560.0, 640.0);
pub const PLUGIN_WINDOW_MIN_SIZE: (f64, f64) = (420.0, 360.0);

/// 插件窗口标签前缀，完整标签形如 `plugin_<插件id>`。
///
/// **这个标签是插件身份的锚点，不能只当命名约定看**。五条能力命令都从调用方窗口的
/// 标签反推插件 id，而不是采纳命令参数里那个 `plugin_id`——参数是插件自己填的，
/// 采纳它等于让插件 A 能声明成 B 去读写 B 的包内文件。插件页面无法伪造自己的标签
/// （改标签要 `core:window` 权限，插件窗口一条 Tauri 权限都没有）。
///
/// 与前端 `entities/pluginPackage/window.ts` 的 `PLUGIN_WINDOW_LABEL_PREFIX` 必须一致。
pub const PLUGIN_WINDOW_LABEL_PREFIX: &str = "plugin_";

/* -------------------------------------------------------------------------- */
/* 能力权限字符串                                                              */
/* -------------------------------------------------------------------------- */

/// 以下是清单 `permissions` 里允许出现的权限字符串。
///
/// 与服务层「每条能力命令执行前查一遍清单」直接相关：字符串错一个字，插件就会在
/// 运行期被自己的宿主拒绝，而清单看起来完全正常。与前端 `PLUGIN_PERMISSIONS`、
/// `PLUGIN_PERMISSION_DEFINITIONS` 必须一一对应，`scripts/verify-plugins.mjs`
/// 会比对两边的集合。
pub const PLUGIN_PERMISSION_FS_READ: &str = "fs:read";
pub const PLUGIN_PERMISSION_FS_WRITE: &str = "fs:write";
pub const PLUGIN_PERMISSION_LOG_WRITE: &str = "log:write";
pub const PLUGIN_PERMISSION_NET_REQUEST: &str = "net:request";
pub const PLUGIN_PERMISSION_UI_NOTIFY: &str = "ui:notify";

/// 宿主认识的全部能力权限。
///
/// 与逐条常量并列而不是只留这一个数组：命令里写的是具名常量，清单校验要的是集合，
/// 两边都从同一处取，避免「加了权限但忘了加进集合」。
pub const PLUGIN_PERMISSIONS: &[&str] = &[
    PLUGIN_PERMISSION_FS_READ,
    PLUGIN_PERMISSION_FS_WRITE,
    PLUGIN_PERMISSION_LOG_WRITE,
    PLUGIN_PERMISSION_NET_REQUEST,
    PLUGIN_PERMISSION_UI_NOTIFY,
];

/// 插件网络请求的超时时间，单位为秒。
///
/// 没有超时的话，目标站点不响应时插件会永远等不到结果，用户也看不到任何提示；
/// 插件与宿主同处一个进程，挂起的请求会一直占着异步任务。
pub const PLUGIN_HTTP_TIMEOUT_SECS: u64 = 20;

/// 插件网络响应体的读取上限，单位为字节。
///
/// 响应体会整体序列化后跨 IPC 交给前端，不设上限的话一次大文件下载就能把内存打满。
pub const PLUGIN_HTTP_RESPONSE_MAX_BYTES: usize = 2 * 1024 * 1024;
