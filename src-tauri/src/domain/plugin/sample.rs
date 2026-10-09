//! 内置示例插件包源码。
//!
//! 插件根目录首次为空时，服务层会把这份源码写进磁盘，让「写一个插件」这件事在新机器上
//! 有可直接对照的样本，而不需要用户先去别处找插件。
//!
//! 文件真身是仓库根目录 `plugins/` 下的若干目录，通过 `include_str!` 在编译期内嵌。
//! 使用 `CARGO_MANIFEST_DIR` 拼路径而不是多级 `..`，避免文件层级调整后相对路径静默
//! 指向错误位置。
//!
//! 内嵌的是**多个**包：示例的作用是让作者照着改，而「只用宿主能力的最小插件」与
//! 「多页面 + 能力桥组合使用」是两种不同的写法，只给一个包时另一种形态就没有可参考的
//! 样本。

/// 示例插件包里的一个文件。
///
/// `file_name` 允许带子目录，但示例包刻意都放在包根目录——多一层目录会让「相对链接
/// 怎么解析」这件事混进示例，而那是插件作者自己的选择，不是框架约定。
pub struct SampleFile {
    /// 相对插件包目录的文件名。
    pub file_name: &'static str,
    /// 文件内容。
    pub source: &'static str,
}

/// 一个内置示例插件包。
///
/// 用结构体而不是若干并列常量，是为了让「清单里声明的 id / entry」与「播种时写入的
/// 目录名 / 文件名」在同一个字面量里挨着出现 —— 这两处一旦漂移，扫描会以
/// 「清单 id 与目录名不一致」直接报错，属于必须一眼能校对的关系。
pub struct SamplePackage {
    /// 包目录名，同时也是清单里的 `id`。
    pub package_id: &'static str,
    /// 入口页面文件名，必须与内嵌清单中的 `entry` 字段保持一致。
    pub entry_file_name: &'static str,
    /// 清单文件内容。
    pub manifest_source: &'static str,
    /// 需要落盘的全部页面文件，**含入口页面本身**。
    ///
    /// 入口页面也列在这里而不是单列一个字段：包里有几个文件应当只有一个事实来源，
    /// 否则「入口文件漏写进播种循环」这类错误不会有任何测试能发现。脚本文件同样要列全，
    /// 漏一个的表现是页面打开后按钮点了没反应——比 404 更难查。
    pub files: &'static [SampleFile],
}

/// 全部内置示例插件包。
///
/// 数组顺序即播种顺序，也是扫描排序前的初始顺序；扫描层仍会按 id 重新排序，
/// 因此这里不需要额外维护字母序。
pub const SAMPLE_PACKAGES: &[SamplePackage] = &[
    SamplePackage {
        package_id: "hello-dasktop",
        entry_file_name: "index.html",
        manifest_source: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../plugins/hello-dasktop/plugin.json"
        )),
        files: &[
            SampleFile {
                file_name: "index.html",
                source: include_str!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../plugins/hello-dasktop/index.html"
                )),
            },
            SampleFile {
                file_name: "index.js",
                source: include_str!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../plugins/hello-dasktop/index.js"
                )),
            },
        ],
    },
    SamplePackage {
        package_id: "http-console",
        entry_file_name: "index.html",
        manifest_source: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../plugins/http-console/plugin.json"
        )),
        files: &[
            SampleFile {
                file_name: "index.html",
                source: include_str!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../plugins/http-console/index.html"
                )),
            },
            SampleFile {
                file_name: "index.js",
                source: include_str!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../plugins/http-console/index.js"
                )),
            },
            SampleFile {
                file_name: "history.html",
                source: include_str!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../plugins/http-console/history.html"
                )),
            },
            SampleFile {
                file_name: "history.js",
                source: include_str!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../plugins/http-console/history.js"
                )),
            },
            SampleFile {
                file_name: "state.js",
                source: include_str!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../plugins/http-console/state.js"
                )),
            },
        ],
    },
];
