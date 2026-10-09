//! 插件包文件系统基础设施。
//!
//! 只做三件事：扫描插件根目录、解析清单与入口源码、把「插件包内相对路径」安全地
//! 解析成绝对路径。这里不理解权限、不理解宿主能力，因此可以被命令层直接复用。

use std::path::{Component, Path, PathBuf};

use crate::domain::plugin::{
    PluginManifest, PluginPackageRecord, PluginScanResult, SamplePackage, PLUGIN_ASSET_MAX_BYTES,
    PLUGIN_DATA_MAX_BYTES, PLUGIN_ID_MAX_LENGTH, PLUGIN_MANIFEST_FILE_NAME, SAMPLE_PACKAGES,
};

/// 目录扫描时跳过的宿主自用目录首字符集合。
///
/// `.` 开头的目录在 Windows 上同样允许存在，`_` 前缀则是插件作者表达「草稿」的常见习惯；
/// 两者都保留给宿主和作者临时存放内容，不参与插件解析，避免半成品目录反复报错。
const IGNORED_DIRECTORY_PREFIXES: &str = "._";

/// 判断目录名是否属于宿主自用目录。
///
/// 必须按「首字符是否在集合内」判断，不能写成 `starts_with(IGNORED_DIRECTORY_PREFIXES)`：
/// 后者匹配的是字面前缀 `"._"` 这个两字符序列，会把 `.cache` 和 `_draft` 全部漏掉。
fn is_reserved_directory_name(directory_name: &str) -> bool {
    directory_name
        .chars()
        .next()
        .is_some_and(|first_character| IGNORED_DIRECTORY_PREFIXES.contains(first_character))
}

/// 创建插件根目录；已存在时保持原状，不覆盖用户手工放入的插件包。
pub fn ensure_root(root: &Path) -> Result<(), String> {
    if root.is_dir() {
        return Ok(());
    }

    std::fs::create_dir_all(root)
        .map_err(|error| format!("无法创建插件目录 {}：{error}", root.display()))
}

/// 扫描插件根目录，返回全部插件包记录。
///
/// 单个插件包解析失败不会中断整次扫描：失败原因记录在对应记录里返回给前端，
/// 这样「一个坏插件」不会连带其它插件一起不可用。
pub fn scan_packages(root: &Path) -> Result<PluginScanResult, String> {
    ensure_root(root)?;

    let entries = std::fs::read_dir(root)
        .map_err(|error| format!("无法读取插件目录 {}：{error}", root.display()))?;

    let mut packages = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|error| format!("插件目录项读取失败：{error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("插件目录项类型读取失败：{error}"))?;

        if !file_type.is_dir() {
            continue;
        }

        let directory_name = entry.file_name().to_string_lossy().to_string();
        if is_reserved_directory_name(&directory_name) {
            continue;
        }

        packages.push(load_package_record(&entry.path(), &directory_name));
    }

    // 目录枚举顺序由文件系统决定，排序后前端的热重载差异比对才不会被顺序抖动干扰。
    packages.sort_by(|left, right| left.id.cmp(&right.id));

    Ok(PluginScanResult {
        root_path: root.to_string_lossy().to_string(),
        packages,
    })
}

/// 插件根目录下不存在任何子目录时写入内置示例包；返回本次是否真的写入了内容。
///
/// 判据是「有没有子目录」而不是「目录是否为空」：只要用户曾经放过插件（哪怕之后删掉），
/// 就不再补写示例，避免示例包反复出现、看起来像删不掉的垃圾。
///
/// **整批一起写**：先把全部包写入临时目录再改名到最终位置的做法在此不必要——写入失败时
/// 已落盘的包留在磁盘上并不是安全问题（它们本就是只读样本），而任何一次「用户已有插件」
/// 之后的启动都不会再补写，不会出现反复补写补不齐的循环。因此这里只保证「失败即返回
/// 明确错误」，不做事务式回滚。
pub fn seed_sample_package_if_empty(root: &Path) -> Result<bool, String> {
    ensure_root(root)?;

    if has_child_directory(root)? {
        return Ok(false);
    }

    for package in SAMPLE_PACKAGES {
        write_sample_package(root, package)?;
    }

    Ok(true)
}

/// 把单个内置示例包写入插件根目录。
///
/// 逐包写入而不是内联在循环里，是为了让错误信息带上具体包名——两个包中任一写失败时，
/// 用户需要知道是哪一个，否则只能看到一个「无法写入示例插件入口」的笼统提示。
fn write_sample_package(root: &Path, package: &SamplePackage) -> Result<(), String> {
    let package_dir = root.join(package.package_id);
    std::fs::create_dir_all(&package_dir).map_err(|error| {
        format!(
            "无法创建示例插件目录 {}：{error}",
            package_dir.display()
        )
    })?;

    std::fs::write(
        package_dir.join(PLUGIN_MANIFEST_FILE_NAME),
        package.manifest_source,
    )
    .map_err(|error| format!("无法写入示例插件 {} 的清单：{error}", package.package_id))?;

    for file in package.files {
        std::fs::write(package_dir.join(file.file_name), file.source).map_err(|error| {
            format!(
                "无法写入示例插件 {} 的 {}：{error}",
                package.package_id, file.file_name
            )
        })?;
    }

    Ok(())
}

/// 按插件 id 定位插件包目录。
///
/// id 直接参与路径拼接，必须先做字符白名单校验；否则 `../..` 之类的 id 会让后续所有
/// 沙箱校验都建立在错误的基准目录上。
pub fn resolve_package_dir(root: &Path, plugin_id: &str) -> Result<PathBuf, String> {
    if !is_valid_plugin_id(plugin_id) {
        return Err(format!("非法插件 id：{plugin_id}"));
    }

    let package_dir = root.join(plugin_id);
    if !package_dir.is_dir() {
        return Err(format!("插件包不存在：{plugin_id}"));
    }

    Ok(package_dir)
}

/// 插件 id 只允许 ASCII 字母、数字、点、下划线和短横线。
///
/// 拒绝的字符集足够覆盖路径分隔符、Windows 驱动器前缀、NTFS 数据流冒号和空字节，
/// 同时不限制常见的 `my.plugin-name_v2` 命名风格。
pub fn is_valid_plugin_id(plugin_id: &str) -> bool {
    !plugin_id.is_empty()
        && plugin_id.len() <= PLUGIN_ID_MAX_LENGTH
        && plugin_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
}

/// 读取插件包内的页面资源，供插件页面协议处理器使用。
///
/// 与 [`read_package_file`] 的关键区别是**按字节读取**：插件页面会引用图片、字体、
/// wasm 这类非文本资源，用 `read_to_string` 碰到任何非 UTF-8 字节都会直接失败。
/// 路径沙箱与 `fs:read` 共用同一条校验，页面资源同样不能逃出插件包目录。
pub fn read_package_asset(package_dir: &Path, relative_path: &str) -> Result<Vec<u8>, String> {
    let path = resolve_sandboxed_path(package_dir, relative_path)?;

    let metadata = std::fs::metadata(&path)
        .map_err(|error| format!("插件资源不可读 {relative_path}：{error}"))?;

    if !metadata.is_file() {
        return Err(format!("插件资源路径不是文件：{relative_path}"));
    }

    if metadata.len() > PLUGIN_ASSET_MAX_BYTES {
        return Err(format!(
            "插件资源超过 {PLUGIN_ASSET_MAX_BYTES} 字节上限：{relative_path}（实际 {} 字节）",
            metadata.len()
        ));
    }

    std::fs::read(&path).map_err(|error| format!("插件资源读取失败 {relative_path}：{error}"))
}

/// 读取插件包内文本文件，供 `fs:read` 能力使用。
pub fn read_package_file(package_dir: &Path, relative_path: &str) -> Result<String, String> {
    read_text_file(package_dir, relative_path, PLUGIN_DATA_MAX_BYTES)
}

/// 写入插件包内文本文件，供 `fs:write` 能力使用；目标目录不存在时自动补齐。
pub fn write_package_file(
    package_dir: &Path,
    relative_path: &str,
    contents: &str,
) -> Result<(), String> {
    let path = resolve_sandboxed_path(package_dir, relative_path)?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建插件数据目录 {}：{error}", parent.display()))?;
    }

    std::fs::write(&path, contents)
        .map_err(|error| format!("插件文件写入失败 {}：{error}", path.display()))
}

/// 把插件包内的相对路径解析成绝对路径，并确保结果一定落在插件包目录内。
///
/// 插件源码来自第三方，路径逃逸是它越权读写宿主文件的主要入口，因此做两道独立校验：
///
/// 1. **逐段形状校验**：拒绝绝对路径、盘符前缀、`..` 上跳，以及 Windows 上的
///    NTFS 数据流写法（`file.txt:stream`）。这一步只看字符串形状，不依赖文件是否存在。
/// 2. **落点规范化校验**：对目标路径「已存在的最近祖先」做 `canonicalize` 后再比对
///    是否仍位于规范化后的插件包目录内。第 1 步无法识别符号链接和目录联接，
///    一个指向 `C:\` 的 junction 就能让 `data/log.txt` 逃出沙箱，这一步专门堵这类绕过。
pub fn resolve_sandboxed_path(package_dir: &Path, relative_path: &str) -> Result<PathBuf, String> {
    if relative_path.trim().is_empty() {
        return Err("插件内路径不能为空".to_string());
    }

    let candidate = Path::new(relative_path);
    if candidate.is_absolute() {
        return Err(format!("插件只能访问包内相对路径：{relative_path}"));
    }

    let mut normalized = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Normal(segment) => {
                let segment = segment.to_string_lossy();
                if segment.contains(':') {
                    return Err(format!("插件路径不允许包含冒号：{relative_path}"));
                }

                normalized.push(segment.as_ref());
            }
            // `./data/log.txt` 这类显式当前目录写法没有安全风险，直接折叠。
            Component::CurDir => {}
            _ => return Err(format!("插件路径不允许包含 .. 或盘符：{relative_path}")),
        }
    }

    if normalized.as_os_str().is_empty() {
        return Err(format!("插件内路径无效：{relative_path}"));
    }

    let package_root = package_dir
        .canonicalize()
        .map_err(|error| format!("插件包目录不可用 {}：{error}", package_dir.display()))?;
    let target = package_root.join(&normalized);

    // 写入场景下目标文件可能尚不存在，因此向上寻找仍存在的最近祖先：
    // 只要该祖先规范化后仍在插件包内，由它派生出的子路径也不可能落到包外。
    let mut probe = target.as_path();
    let existing_ancestor = loop {
        if probe.exists() {
            break probe;
        }

        match probe.parent() {
            Some(parent) => probe = parent,
            None => return Err(format!("插件路径无法解析：{relative_path}")),
        }
    };

    let canonical_ancestor = existing_ancestor
        .canonicalize()
        .map_err(|error| format!("插件路径规范化失败：{error}"))?;

    if !canonical_ancestor.starts_with(&package_root) {
        return Err(format!("插件路径越界，已拒绝访问：{relative_path}"));
    }

    Ok(target)
}

/// 加载单个插件包记录。
///
/// 除清单本身是否可解析之外，这里还强制「清单 id == 目录名」：两者不一致时，
/// 宿主按 id 定位日志与包内文件会落到另一个目录，属于必须提前拦住的配置错误。
fn load_package_record(package_dir: &Path, directory_name: &str) -> PluginPackageRecord {
    let directory_path = package_dir.to_string_lossy().to_string();

    let manifest = match read_manifest(package_dir) {
        Ok(manifest) => manifest,
        Err(error) => {
            return PluginPackageRecord {
                id: directory_name.to_string(),
                directory_path,
                manifest: None,
                error: Some(error),
            }
        }
    };

    if manifest.id != directory_name {
        return PluginPackageRecord {
            id: directory_name.to_string(),
            directory_path,
            manifest: None,
            error: Some(format!(
                "清单 id `{}` 与插件包目录名 `{directory_name}` 不一致",
                manifest.id
            )),
        };
    }

    // 入口页面必须真实存在。拦在扫描期而不是等用户点开插件窗口：那时只会看到一片
    // 空白，而这里能直接说清是哪个文件缺了。
    match resolve_sandboxed_path(package_dir, &manifest.entry) {
        Ok(entry_path) if entry_path.is_file() => {}
        Ok(_) => {
            return PluginPackageRecord {
                id: directory_name.to_string(),
                directory_path,
                manifest: None,
                error: Some(format!("入口页面不存在：{}", manifest.entry)),
            }
        }
        Err(message) => {
            return PluginPackageRecord {
                id: directory_name.to_string(),
                directory_path,
                manifest: None,
                error: Some(format!("入口页面路径非法：{message}")),
            }
        }
    }

    PluginPackageRecord {
        id: directory_name.to_string(),
        directory_path,
        manifest: Some(manifest),
        error: None,
    }
}

/// 解析插件包清单文件。
///
/// 单个包的清单读取同样对服务层开放：读取入口源码时必须先拿到 `entry` 字段，
/// 让服务层复用它比在服务层再拼一次清单路径更不容易写错。
pub fn read_manifest(package_dir: &Path) -> Result<PluginManifest, String> {
    let manifest_path = package_dir.join(PLUGIN_MANIFEST_FILE_NAME);
    if !manifest_path.is_file() {
        return Err(format!("缺少清单文件 {PLUGIN_MANIFEST_FILE_NAME}"));
    }

    let raw = std::fs::read_to_string(&manifest_path)
        .map_err(|error| format!("清单文件读取失败（需为 UTF-8 文本）：{error}"))?;
    let manifest: PluginManifest =
        serde_json::from_str(&raw).map_err(|error| format!("清单文件解析失败：{error}"))?;

    if manifest.id.trim().is_empty() || manifest.name.trim().is_empty() {
        return Err("清单必须声明非空的 id 与 name".to_string());
    }

    if manifest.entry.trim().is_empty() {
        return Err("清单必须声明非空的 entry".to_string());
    }

    Ok(manifest)
}

/// 读取插件包内文本文件并按上限校验体积。
fn read_text_file(
    package_dir: &Path,
    relative_path: &str,
    max_bytes: u64,
) -> Result<String, String> {
    let path = resolve_sandboxed_path(package_dir, relative_path)?;

    let metadata = std::fs::metadata(&path)
        .map_err(|error| format!("插件文件不可读 {relative_path}：{error}"))?;

    if !metadata.is_file() {
        return Err(format!("插件路径不是文件：{relative_path}"));
    }

    if metadata.len() > max_bytes {
        return Err(format!(
            "插件文件超过 {max_bytes} 字节上限：{relative_path}（实际 {} 字节）",
            metadata.len()
        ));
    }

    std::fs::read_to_string(&path)
        .map_err(|error| format!("插件文件读取失败（需为 UTF-8 文本）：{error}"))
}

/// 判断目录下是否存在任何子目录，用于决定是否补写示例插件包。
fn has_child_directory(root: &Path) -> Result<bool, String> {
    let entries = std::fs::read_dir(root)
        .map_err(|error| format!("无法读取插件目录 {}：{error}", root.display()))?;

    for entry in entries {
        let entry = entry.map_err(|error| format!("插件目录项读取失败：{error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("插件目录项类型读取失败：{error}"))?;

        if file_type.is_dir() {
            return Ok(true);
        }
    }

    Ok(false)
}

/// 路径沙箱的回归用例。
///
/// 这些用例覆盖的是「插件能否越权读写宿主文件」这一安全边界，因此必须进自动化测试：
/// 一旦沙箱被改坏，肉眼审查很难发现，而后果是任意文件读写。
#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::plugin::PLUGIN_PERMISSIONS;

    /// 测试用临时插件包目录，析构时自动清理。
    struct TempPackage {
        root: PathBuf,
    }

    impl TempPackage {
        fn new(test_name: &str) -> Self {
            let root = std::env::temp_dir().join(format!("dasktop-plugin-test-{test_name}"));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).expect("测试目录应可创建");

            Self { root }
        }

        fn package_dir(&self) -> PathBuf {
            let package_dir = self.root.join("demo");
            std::fs::create_dir_all(&package_dir).expect("插件包目录应可创建");
            package_dir
        }
    }

    impl Drop for TempPackage {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    /// 写入一个最小可用的插件包，供扫描类用例构造前置状态。
    fn write_package(fixture: &TempPackage, directory_name: &str, manifest_id: &str) -> PathBuf {
        let package_dir = fixture.root.join(directory_name);
        std::fs::create_dir_all(&package_dir).expect("插件包目录应可创建");
        std::fs::write(
            package_dir.join(PLUGIN_MANIFEST_FILE_NAME),
            format!(
                r#"{{"id":"{manifest_id}","name":"测试插件","version":"1.0.0","entry":"index.html","permissions":[]}}"#
            ),
        )
        .expect("清单应可写入");
        std::fs::write(
            package_dir.join("index.html"),
            "<!doctype html><title>测试</title>",
        )
        .expect("入口页面应可写入");

        package_dir
    }

    /// 断言全部内置示例包都完整落盘、可被扫描、可读出入口源码。
    ///
    /// 这里刻意对 `SAMPLE_PACKAGES` 逐个遍历而不是硬编码两个包名：以后再加示例包时，
    /// 测试自动覆盖新包；硬编码会让新包「悄悄不被测」。
    #[test]
    fn seeds_and_reads_back_embedded_sample_packages() {
        let fixture = TempPackage::new("seed-sample");

        assert!(
            seed_sample_package_if_empty(&fixture.root).expect("应写入内置示例包"),
            "空目录首次扫描应写入示例包"
        );
        assert!(
            !seed_sample_package_if_empty(&fixture.root).expect("重复播种应被跳过"),
            "已有插件包时不应再次写入示例包"
        );

        let scan = scan_packages(&fixture.root).expect("扫描应成功");
        assert_eq!(
            scan.packages.len(),
            SAMPLE_PACKAGES.len(),
            "播种后扫描出的包数应与内置示例包数量一致"
        );

        for package in SAMPLE_PACKAGES {
            let record = scan
                .packages
                .iter()
                .find(|record| record.id == package.package_id)
                .unwrap_or_else(|| panic!("示例包 {} 未被扫描到", package.package_id));

            assert!(
                record.error.is_none(),
                "内嵌示例包 {} 应能通过扫描：{:?}",
                package.package_id,
                record.error
            );

            let manifest = record.manifest.as_ref().expect("示例包应解析出清单");
            assert_eq!(
                manifest.id, package.package_id,
                "内嵌清单 id 必须与目录名一致"
            );
            assert_eq!(
                manifest.entry, package.entry_file_name,
                "内嵌清单 entry 必须与播种时写入的文件名一致"
            );

            // 播种出的每个页面都必须能走通「协议处理器读资源」这条链路：这条链路只在
            // 插件窗口打开时才被触发，坏掉的话要等用户点开界面才发现是一片空白。
            let package_dir = fixture.root.join(package.package_id);

            for file in package.files {
                let contents = read_package_asset(&package_dir, file.file_name).unwrap_or_else(
                    |error| {
                        panic!(
                            "示例包 {} 的 {} 应可读取：{error}",
                            package.package_id, file.file_name
                        )
                    },
                );

                assert_eq!(
                    contents.as_slice(),
                    file.source.as_bytes(),
                    "示例包 {} 的 {} 落盘内容与内嵌源码不一致",
                    package.package_id,
                    file.file_name
                );
            }

            // 入口必须在 files 列表里，否则打开插件窗口会直接 404。
            let entry = read_package_asset(&package_dir, &manifest.entry).unwrap_or_else(|error| {
                panic!("示例包 {} 的入口页面应可读取：{error}", package.package_id)
            });
            let markup = String::from_utf8_lossy(&entry).to_ascii_lowercase();

            assert!(
                markup.contains("<!doctype") || markup.contains("<html"),
                "示例包 {} 的入口应是一份 HTML 页面",
                package.package_id
            );
        }
    }

    /// 清单声明的 `entry` 必须真的存在于包目录里。
    ///
    /// 覆盖的是「作者改了清单却没同步文件名」这类错误：它不会在扫描阶段暴露，
    /// 而是等到加载器读源码时才报「插件文件不可读」，排查起来多绕一层。
    #[test]
    fn embedded_sample_manifests_declare_existing_entry_files() {
        for package in SAMPLE_PACKAGES {
            let manifest: PluginManifest = serde_json::from_str(package.manifest_source)
                .unwrap_or_else(|error| {
                    panic!("示例包 {} 的清单不是合法 JSON：{error}", package.package_id)
                });

            assert_eq!(
                manifest.entry, package.entry_file_name,
                "示例包 {} 的清单 entry 与 entry_file_name 不一致",
                package.package_id
            );

            // 入口必须出现在 files 列表里：清单写对了但忘了加进播种列表，扫描完全正常
            // （清单里那个字段没人核对），只有用户点开插件窗口时才会 404。
            assert!(
                package
                    .files
                    .iter()
                    .any(|file| file.file_name == manifest.entry),
                "示例包 {} 的入口 {} 不在 files 列表里，播种后不会落盘",
                package.package_id,
                manifest.entry
            );

            // 声明了宿主不认识的能力时，示例包会被加载器标成不可用——而它正是用来
            // 「照着改」的模板，坏了最难被发现：用户只会以为自己哪里抄错了。
            for permission in &manifest.permissions {
                assert!(
                    PLUGIN_PERMISSIONS.contains(&permission.as_str()),
                    "示例包 {} 声明了宿主不认识的能力：{permission}",
                    package.package_id
                );
            }

            // 空文件同样是坏样本：`.js` 落盘成空文件时页面照常打开，只是什么都不做。
            for file in package.files {
                assert!(
                    !file.source.trim().is_empty(),
                    "示例包 {} 的 {} 内容为空",
                    package.package_id,
                    file.file_name
                );
            }
        }
    }

    #[test]
    fn reports_manifest_directory_mismatch_as_package_error() {
        let fixture = TempPackage::new("id-mismatch");
        write_package(&fixture, "real-dir", "declared-id");

        let scan = scan_packages(&fixture.root).expect("扫描应成功");
        let record = &scan.packages[0];

        assert!(record.manifest.is_none(), "id 不一致时不应给出清单");
        assert!(
            record.error.as_deref().unwrap_or_default().contains("不一致"),
            "错误信息应指出 id 与目录名不一致：{:?}",
            record.error
        );
    }

    #[test]
    fn reports_missing_manifest_as_package_error() {
        let fixture = TempPackage::new("missing-manifest");
        std::fs::create_dir_all(fixture.root.join("broken")).expect("目录应可创建");

        let scan = scan_packages(&fixture.root).expect("扫描应成功");

        assert_eq!(scan.packages.len(), 1);
        assert_eq!(scan.packages[0].id, "broken");
        assert!(
            scan.packages[0]
                .error
                .as_deref()
                .unwrap_or_default()
                .contains(PLUGIN_MANIFEST_FILE_NAME),
            "错误信息应指出缺少清单文件"
        );
    }

    /// 清单声明的入口页面必须真实存在。
    ///
    /// 这条校验的价值在于「失败发生在哪」：少了它，包能正常扫描、正常显示在设置页里，
    /// 直到用户点开插件窗口才看到一片空白，而那时很难联想到是清单里文件名写错了。
    #[test]
    fn reports_missing_entry_page_as_package_error() {
        let fixture = TempPackage::new("missing-entry");
        let package_dir = fixture.root.join("no-entry");
        std::fs::create_dir_all(&package_dir).expect("目录应可创建");
        std::fs::write(
            package_dir.join(PLUGIN_MANIFEST_FILE_NAME),
            r#"{"id":"no-entry","name":"缺入口","version":"1.0.0","entry":"index.html"}"#,
        )
        .expect("清单应可写入");

        let scan = scan_packages(&fixture.root).expect("扫描应成功");
        let record = &scan.packages[0];

        assert!(record.manifest.is_none(), "入口缺失时不应给出清单");
        assert!(
            record
                .error
                .as_deref()
                .unwrap_or_default()
                .contains("入口页面不存在"),
            "错误信息应指出入口页面缺失：{:?}",
            record.error
        );
    }

    #[test]
    fn skips_host_reserved_directories() {
        let fixture = TempPackage::new("skip-reserved");
        write_package(&fixture, ".cache", ".cache");
        write_package(&fixture, "_draft", "_draft");
        write_package(&fixture, "real-plugin", "real-plugin");

        let scan = scan_packages(&fixture.root).expect("扫描应成功");

        assert_eq!(scan.packages.len(), 1, "保留目录不应参与解析");
        assert_eq!(scan.packages[0].id, "real-plugin");
    }

    #[test]
    fn rejects_parent_directory_escape() {
        let fixture = TempPackage::new("escape-parent");
        let package_dir = fixture.package_dir();

        for relative_path in ["../secret.txt", "data/../../secret.txt", "./../secret.txt"] {
            let result = resolve_sandboxed_path(&package_dir, relative_path);
            assert!(result.is_err(), "应拒绝上跳路径：{relative_path}");
        }
    }

    #[test]
    fn rejects_absolute_and_drive_paths() {
        let fixture = TempPackage::new("escape-absolute");
        let package_dir = fixture.package_dir();

        for relative_path in ["C:/Windows/win.ini", "C:state.json", "/etc/passwd"] {
            let result = resolve_sandboxed_path(&package_dir, relative_path);
            assert!(result.is_err(), "应拒绝绝对路径：{relative_path}");
        }
    }

    #[test]
    fn rejects_ntfs_data_stream_paths() {
        let fixture = TempPackage::new("escape-ads");
        let package_dir = fixture.package_dir();

        let result = resolve_sandboxed_path(&package_dir, "state.json:hidden");
        assert!(result.is_err(), "应拒绝 NTFS 数据流写法");
    }

    #[test]
    fn accepts_nested_paths_inside_package() {
        let fixture = TempPackage::new("accept-nested");
        let package_dir = fixture.package_dir();

        let resolved = resolve_sandboxed_path(&package_dir, "data/nested/state.json")
            .expect("包内嵌套路径应被接受");
        let canonical_package = package_dir.canonicalize().expect("插件包目录应可规范化");

        assert!(resolved.starts_with(&canonical_package));
    }

    #[test]
    fn write_then_read_round_trip_inside_package() {
        let fixture = TempPackage::new("round-trip");
        let package_dir = fixture.package_dir();

        write_package_file(&package_dir, "data/state.json", "{\"ok\":true}")
            .expect("包内写入应成功");
        let contents = read_package_file(&package_dir, "data/state.json").expect("包内读取应成功");

        assert_eq!(contents, "{\"ok\":true}");
    }

    #[test]
    fn rejects_package_asset_escape() {
        let fixture = TempPackage::new("escape-asset");
        let package_dir = fixture.package_dir();

        for relative_path in ["../secret.html", "/etc/passwd", "a/../../b.html"] {
            assert!(
                read_package_asset(&package_dir, relative_path).is_err(),
                "页面资源同样不能越出插件包目录：{relative_path}"
            );
        }
    }

    #[test]
    fn rejects_invalid_plugin_ids() {
        for plugin_id in ["../escape", "a/b", "a\\b", "", "state.json:hidden", "滥用插件"] {
            assert!(!is_valid_plugin_id(plugin_id), "应拒绝 id：{plugin_id}");
        }

        for plugin_id in ["hello-dasktop", "my.plugin_v2"] {
            assert!(is_valid_plugin_id(plugin_id), "应接受 id：{plugin_id}");
        }
    }
}
