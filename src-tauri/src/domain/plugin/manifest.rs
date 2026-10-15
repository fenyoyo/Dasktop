//! 插件清单与扫描结果的领域类型。
//!
//! 这些结构是前后端共享的传输契约，必须保持纯数据可序列化：未来插件从「本地目录」
//! 扩展到「远端仓库下载」时，同一份结构可以直接复用，不需要重新定义协议。

use serde::{Deserialize, Serialize};

use super::window_size::PluginWindowSizeView;

/// 清单里可选的窗口尺寸声明。
///
/// 宽高各自可选而不是要求成对给出：有的插件只在一侧有要求（比如固定宽度的侧边工具
/// 面板，高度由内容撑开即可），要求成对会让作者在不知道宿主默认值的另一侧硬填一个数。
/// 未声明的那一维各自回落到宿主的全局默认值，而不是把整段声明丢掉。
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct PluginWindowPreference {
    /// 作者建议的窗口宽度（逻辑像素），宿主会把它夹取到允许范围内。
    pub width: Option<f64>,
    /// 作者建议的窗口高度（逻辑像素），宿主会把它夹取到允许范围内。
    pub height: Option<f64>,
}

/// 插件清单，字段与插件包内 `plugin.json` 一一对应。
///
/// 反序列化使用 `deny_unknown_fields` 之外的最宽松策略：未知字段被忽略，
/// 让新版本清单可以在旧宿主上降级运行；真正危险的是字段缺失，因此 `entry`
/// 与 `id` 由 [`crate::infrastructure::filesystem::plugin_package`] 在解析后强校验。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginManifest {
    /// 插件唯一标识，约定与插件包目录名一致，宿主据此定位包内文件与日志文件。
    pub id: String,
    /// 界面展示名称，允许包含中文。
    pub name: String,
    /// 插件版本号，由插件作者自行维护，宿主当前只做展示不参与兼容判断。
    pub version: String,
    /// 入口页面相对插件包目录的路径，只允许包内相对路径。
    ///
    /// 指向一份 HTML 文件，宿主开插件窗口时就以它为起始地址；包里的其它页面由插件
    /// 自己用相对链接跳转，宿主不介入。入口不必叫 `index.html`，但文件必须真实存在。
    pub entry: String,
    /// 插件作者声明的窗口尺寸，宿主在用户没有为这个插件单独记住尺寸时采用它。
    ///
    /// 它是「作者的建议」而不是硬约束：用户一旦手动改过该插件窗口的大小，宿主记住的
    /// 值优先。完整优先级见 [`crate::services::plugin::window_preference`]。
    #[serde(default)]
    pub window: Option<PluginWindowPreference>,
    /// 插件声明的能力清单。
    ///
    /// 宿主后端只做透传，不做任何权限判断：权限字符串到宿主命令的映射表由前端
    /// 权限门控层持有，后端命令即使被直接调用也不区分调用方。
    #[serde(default)]
    pub permissions: Vec<String>,
}

/// 扫描结果中的单个插件包记录。
///
/// 清单损坏的包同样出现在列表里并携带 `error`，而不是被静默丢弃：
/// 宿主面板需要向用户解释「这个目录为什么没有被加载」，静默跳过会让排查无从下手。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPackageRecord {
    /// 插件包目录名，同时也是清单 id 的期望值。
    pub id: String,
    /// 插件包绝对路径，供宿主面板「打开目录」和排查使用。
    pub directory_path: String,
    /// 解析成功时为清单内容，解析失败时为 `None`。
    pub manifest: Option<PluginManifest>,
    /// 该包未被加载的原因，成功时为 `None`。
    pub error: Option<String>,
    /// 宿主为这个插件算好的生效窗口尺寸，由服务层在扫描完成后回填。
    ///
    /// 放在记录里而不是让前端自己算：尺寸是三级优先级（用户记住的 > 清单声明 > 全局
    /// 默认）收敛的结果，规则实现在一处才能保证「面板显示的值」与「开窗用的值」永远
    /// 是同一个。基础设施层构造记录时填全局默认，服务层随后按清单与数据库覆盖。
    pub window_size: PluginWindowSizeView,
}

/// 插件扫描结果。
///
/// 携带根目录是为了让宿主面板直接展示插件安装位置，避免前端再走一次路径查询命令。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginScanResult {
    /// 插件包根目录绝对路径，首次扫描时若不存在会被创建。
    pub root_path: String,
    /// 按目录名升序排列的插件包记录，顺序稳定以便前端做差异比对。
    pub packages: Vec<PluginPackageRecord>,
}
