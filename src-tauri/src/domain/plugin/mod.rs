//! 插件包领域层。
//!
//! 只定义清单结构、扫描结果和跨层契约常量，不触碰任何文件系统调用：
//! 真实目录扫描与路径沙箱位于基础设施层，宿主能力编排位于服务层。

mod contract;
mod manifest;
mod sample;

pub use contract::{
    PLUGIN_DATA_MAX_BYTES, PLUGIN_ENTRY_MAX_BYTES, PLUGIN_ID_MAX_LENGTH, PLUGIN_LOG_DIR_NAME,
    PLUGIN_LOG_MAX_BYTES, PLUGIN_MANIFEST_FILE_NAME, PLUGIN_NOTIFICATION_EVENT,
    PLUGIN_ROOT_DIR_NAME,
};
pub use manifest::{PluginManifest, PluginPackageRecord, PluginScanResult};
pub use sample::{
    SAMPLE_ENTRY_FILE_NAME, SAMPLE_ENTRY_SOURCE, SAMPLE_MANIFEST, SAMPLE_PACKAGE_ID,
};
