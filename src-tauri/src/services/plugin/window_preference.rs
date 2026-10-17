//! 插件窗口尺寸的解析。
//!
//! 尺寸只来自插件清单（`plugin.json` 的 `window` 字段）的声明值：插件作者写多少就开多少，
//! 不再记忆用户拖出来的尺寸、也不再读全局默认。清单没写时回落到合约内置默认
//! （[`PLUGIN_WINDOW_SIZE`]），保证窗口一定能开出来。

use crate::domain::plugin::{
    PluginManifest, PluginWindowSize, PluginWindowSizeSource, PluginWindowSizeView,
};

/// 解析插件窗口打开时应采用的尺寸。
///
/// 仅取清单声明值，按合约边界夹取；维度缺失时回落到合约默认尺寸。不读库、不记忆用户偏好。
pub async fn resolve_window_size(
    _app: &tauri::AppHandle,
    _plugin_id: &str,
    manifest: Option<&PluginManifest>,
) -> PluginWindowSizeView {
    let declared = manifest.and_then(|manifest| manifest.window).unwrap_or_default();

    let source = if declared.width.is_some() || declared.height.is_some() {
        PluginWindowSizeSource::Declared
    } else {
        PluginWindowSizeSource::Global
    };

    let default = PluginWindowSize::default_size();
    let size = PluginWindowSize::clamped(
        declared.width.unwrap_or(default.width),
        declared.height.unwrap_or(default.height),
    );

    PluginWindowSizeView::new(size, source)
}
