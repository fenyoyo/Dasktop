//! 插件网络能力的数据契约。
//!
//! 请求与响应都需要跨 IPC 边界，因此字段全部是 JSON 可直接表达的基本类型：
//! 不出现字节数组、不出现流，响应体统一按文本承载。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// 插件发起的 HTTP 请求。
///
/// 只有 `url` 是必填项，其余字段都取自插件侧的默认值，让常见的「取一个接口」场景
/// 写成一行调用即可。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginHttpRequest {
    /// 请求头，键按字典序排列以保证日志与测试输出稳定。
    #[serde(default)]
    pub headers: Option<BTreeMap<String, String>>,
    /// 请求方法，缺省为 GET；方法名不合法时由基础设施层拒绝。
    #[serde(default)]
    pub method: Option<String>,
    /// 请求体，按 UTF-8 文本承载。
    #[serde(default)]
    pub body: Option<String>,
    /// 目标地址，仅接受 http / https 协议。
    pub url: String,
}

/// 插件 HTTP 请求的结果。
///
/// 状态码与响应体一同返回而不是在非 2xx 时抛错：调用外部接口时 4xx 往往带有
/// 插件需要读取的说明正文，把它变成异常会迫使插件再发一次请求。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginHttpResponse {
    /// 响应体文本；非 UTF-8 内容在基础设施层做有损转换。
    pub body: String,
    /// 响应头，同名头以逗号合并。
    pub headers: BTreeMap<String, String>,
    /// HTTP 状态码。
    pub status: u16,
}
