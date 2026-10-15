//! 插件窗口尺寸的领域约定。
//!
//! 两件事：把任意来源的宽高收敛成一个宿主能安全使用的值，以及描述这个值是怎麼来的。
//!
//! 「来源」不是给宿主自己看的，而是给宿主面板看的：同一个 720×680 可能来自用户拖出来的
//! 窗口、清单声明或全局默认，面板要能说清是哪一种，尺寸本身不携带这个信息。
//!
//! # 为什么必须夹取而不是照单全收
//!
//! 宿主给窗口设了下限之后，WebView 会自行把更小的窗口拉回下限。于是「用户配了
//! 200×200」这条路走完，读回来的窗口尺寸是下限值而不是他配的值——如果把这个值原样
//! 记住，下一次开窗用户会看到一个既不是默认值也不是自己设置值的尺寸，而宿主这边
//! 毫无异常可查。
//!
//! 三个来源都可能出现越界值：设置页的输入框、插件清单里作者随手写的数字、
//! 以及被手工改过的 SQLite 记录。它们在这里汇合，一次夹取覆盖全部。

use serde::Serialize;

use super::contract::{PLUGIN_WINDOW_MAX_SIZE, PLUGIN_WINDOW_MIN_SIZE, PLUGIN_WINDOW_SIZE};

/// 生效尺寸的来源，宿主面板据此说明「为什么是这个值」。
///
/// 大小写由 serde 转成 camelCase 后与前端的 `PluginWindowSizeSource` 对应：
/// 面板靠这个字符串选文案，新增来源而前端没收到的情况会在渲染时暴露成空白说明行，
/// 比悄悄回落到一个解释不通的来源更容易被发现。
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PluginWindowSizeSource {
    /// 用户为这个插件单独记住（或调整过）的尺寸。
    Custom,
    /// 插件清单 `window` 字段里作者声明的尺寸。
    Declared,
    /// 全局默认尺寸。
    Global,
}

/// 插件窗口当前会采用的尺寸及其来源，随扫描结果一并返回给宿主面板。
///
/// 它是**宿主算好的结果**而不是供前端自行推导的原料：尺寸规则只在 Rust 侧实现一次，
/// 前端不再需要复刻优先级与夹取。两端各算一遍时，漂移只能靠人工比对常量发现，
/// 而「面板显示 800×600、开窗却是 560×640」这类偏差两侧都不会报错。
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginWindowSizeView {
    /// 宽度，单位为逻辑像素。
    pub width: f64,
    /// 高度，单位为逻辑像素。
    pub height: f64,
    /// 这个尺寸是从哪一级取到的。
    pub source: PluginWindowSizeSource,
}

impl PluginWindowSizeView {
    /// 组装一条生效尺寸记录。
    ///
    /// 宽高直接取 [`PluginWindowSize`] 而不是再传两个数：尺寸在交给这里之前必须已经
    /// 夹取过，拆成裸 f64 会让「忘了夹取」这个错误在类型上失去抓手。
    pub fn new(size: PluginWindowSize, source: PluginWindowSizeSource) -> Self {
        Self {
            width: size.width,
            height: size.height,
            source,
        }
    }

    /// 全局默认尺寸，用于清单解析失败的包：它们开不了窗，但面板仍要显示一行尺寸，
    /// 因此给默认值而不是让字段变成可选——可选会把「没算出来」和「就是默认」混为一谈。
    pub fn global_default() -> Self {
        Self::new(PluginWindowSize::default_size(), PluginWindowSizeSource::Global)
    }
}

/// 插件窗口尺寸，单位为**逻辑像素**。
///
/// 刻意用逻辑像素而不是物理像素：多显示器环境下同一个窗口在不同缩放率的屏幕之间
/// 移动时，物理尺寸会随缩放率变化而逻辑尺寸不变。记逻辑尺寸才能让「上次调好的大小」
/// 跨屏幕保持一致，否则用户把窗口从 100% 屏拖到 150% 屏，下一次开窗就缩水了。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PluginWindowSize {
    /// 窗口内容区宽度。
    pub width: f64,
    /// 窗口内容区高度。
    pub height: f64,
}

impl PluginWindowSize {
    /// 取宿主的默认窗口尺寸，即 [`PLUGIN_WINDOW_SIZE`]。
    ///
    /// 它同时也是「什么都没配」时的兜底值，因此在写 ill-formed 数据的回退路径时
    /// 不该再另起一个字面量。
    pub fn default_size() -> Self {
        Self {
            width: PLUGIN_WINDOW_SIZE.0,
            height: PLUGIN_WINDOW_SIZE.1,
        }
    }

    /// 把一对宽高夹取到宿主允许的范围内。
    ///
    /// 逐维处理而不是「这对尺寸要么全收要么全丢」：清单允许只声明宽度，此时高度
    /// 应当各自回落到全局默认值，逼作者在不知道宿主默认的情况下顺手补一个数字只会
    /// 得到更糟的结果。数值本身非法（NaN / 无穷大）时整维回落到默认值——这类值多半来自
    /// 被改脏的持久化记录，就地夹到边界会让「我看 Win 里配的明明是数字」无法解释。
    pub fn clamped(width: f64, height: f64) -> Self {
        Self {
            width: Self::clamp_dimension(
                width,
                PLUGIN_WINDOW_MIN_SIZE.0,
                PLUGIN_WINDOW_MAX_SIZE.0,
                PLUGIN_WINDOW_SIZE.0,
            ),
            height: Self::clamp_dimension(
                height,
                PLUGIN_WINDOW_MIN_SIZE.1,
                PLUGIN_WINDOW_MAX_SIZE.1,
                PLUGIN_WINDOW_SIZE.1,
            ),
        }
    }

    /// 夹取单个维度。
    ///
    /// 结果取整：尺寸来自输入框与 DPI 换算时都可能带上小数，而一个 563.2 的宽度
    /// 在设置页里显示成小数既无意义又看起来像出了故障。
    fn clamp_dimension(value: f64, min: f64, max: f64, fallback: f64) -> f64 {
        if !value.is_finite() {
            return fallback;
        }

        value.clamp(min, max).round()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn undersized_dimensions_are_lifted_to_the_minimum() {
        // WebView 会把低于下限的窗口自行拉回下限，这里提前夹取，
        // 避免「记住」一个永远不会真实生效的尺寸。
        assert_eq!(
            PluginWindowSize::clamped(200.0, 100.0),
            PluginWindowSize {
                width: PLUGIN_WINDOW_MIN_SIZE.0,
                height: PLUGIN_WINDOW_MIN_SIZE.1,
            }
        );
    }

    #[test]
    fn oversized_dimensions_are_capped() {
        assert_eq!(
            PluginWindowSize::clamped(9999.0, 8888.0),
            PluginWindowSize {
                width: PLUGIN_WINDOW_MAX_SIZE.0,
                height: PLUGIN_WINDOW_MAX_SIZE.1,
            }
        );
    }

    #[test]
    fn illegal_numbers_fall_back_to_the_default() {
        // NaN 与无穷大来自被改脏的持久化记录；夹到边界会让用户看到的尺寸无法解释，
        // 回落到默认值反而一眼能看出「设置丢了」。
        assert_eq!(
            PluginWindowSize::clamped(f64::NAN, f64::INFINITY),
            PluginWindowSize::default_size()
        );
    }

    #[test]
    fn fractional_dimensions_are_rounded() {
        // 尺寸可能来自 DPI 换算（物理像素 ÷ 缩放率），小数在设置页里只会显得像故障。
        assert_eq!(PluginWindowSize::clamped(563.2, 640.5).width, 563.0);
        assert_eq!(PluginWindowSize::clamped(563.2, 640.5).height, 641.0);
    }
}
