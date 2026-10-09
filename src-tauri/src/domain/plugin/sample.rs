//! 内置示例插件包源码。
//!
//! 插件根目录首次为空时，服务层会把这份源码写进磁盘，让「安装插件」这件事在新机器上
//! 有可直接对照的样本，而不需要用户先去别处找插件。
//!
//! 源码真身是仓库根目录 `plugins/` 下的若干目录，通过 `include_str!` 在编译期内嵌。
//! 使用 `CARGO_MANIFEST_DIR` 拼路径而不是多级 `..`，避免文件层级调整后相对路径静默
//! 指向错误位置。
//!
//! 内嵌的是**多个**包而不是单个：示例的作用是让作者照着改，只给一个包时，
//! 框架里 `fs`/`log` 之外的能力（`net:request`、`ui:panel`）就没有可参考的写法。

/// 一个内置示例插件包的完整源码。
///
/// 用结构体而不是若干并列常量，是为了让「清单里声明的 id / entry」与「播种时写入的
/// 目录名 / 文件名」在同一个字面量里挨着出现 —— 这两处一旦漂移，扫描会以
/// 「清单 id 与目录名不一致」直接报错，属于必须一眼能校对的关系。
pub struct SamplePackage {
    /// 包目录名，同时也是清单里的 `id`。
    pub package_id: &'static str,
    /// 入口文件名，必须与内嵌清单中的 `entry` 字段保持一致。
    pub entry_file_name: &'static str,
    /// 清单文件内容。
    pub manifest_source: &'static str,
    /// 入口源码内容。
    pub entry_source: &'static str,
}

/// 全部内置示例插件包。
///
/// 数组顺序即播种顺序，也是扫描排序前的初始顺序；扫描层仍会按 id 重新排序，
/// 因此这里不需要额外维护字母序。
pub const SAMPLE_PACKAGES: &[SamplePackage] = &[
    SamplePackage {
        package_id: "hello-dasktop",
        entry_file_name: "index.js",
        manifest_source: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../plugins/hello-dasktop/plugin.json"
        )),
        entry_source: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../plugins/hello-dasktop/index.js"
        )),
    },
    SamplePackage {
        package_id: "http-console",
        entry_file_name: "index.js",
        manifest_source: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../plugins/http-console/plugin.json"
        )),
        entry_source: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../plugins/http-console/index.js"
        )),
    },
];
