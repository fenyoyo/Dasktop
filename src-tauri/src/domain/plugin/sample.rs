//! 内置示例插件包源码。
//!
//! 插件根目录首次为空时，服务层会把这份源码写进磁盘，让「安装插件」这件事在新机器上
//! 有一个可直接对照的样本，而不需要用户先去别处找插件。
//!
//! 源码真身是仓库根目录 `plugins/hello-dasktop/` 下的两个文件，通过 `include_str!`
//! 在编译期内嵌。使用 `CARGO_MANIFEST_DIR` 拼路径而不是多级 `..`，避免文件层级调整后
//! 相对路径静默指向错误位置。

/// 示例插件包目录名，同时也是清单里的 id。
pub const SAMPLE_PACKAGE_ID: &str = "hello-dasktop";

/// 示例插件入口文件名，必须与内嵌清单中的 `entry` 字段保持一致。
pub const SAMPLE_ENTRY_FILE_NAME: &str = "index.js";

/// 示例插件清单内容。
pub const SAMPLE_MANIFEST: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../plugins/hello-dasktop/plugin.json"
));

/// 示例插件入口源码。
pub const SAMPLE_ENTRY_SOURCE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../plugins/hello-dasktop/index.js"
));
