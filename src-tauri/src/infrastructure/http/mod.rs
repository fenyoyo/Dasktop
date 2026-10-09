//! 插件网络能力的基础设施实现。
//!
//! 只负责「把请求发出去、把响应收回来」，不关心调用方是谁：权限门控在前端受控上下文，
//! 插件身份核对在服务层，本层拿到的是一个已经决定要发的请求。
//!
//! 刻意不接受回环地址与 file 协议之外的任何地址语义：这里不做域名白名单（粒度由用户选择
//! 为「仅权限门控」），因此把校验集中在「协议」与「体积」两件能确定的事情上。

use std::collections::BTreeMap;
use std::sync::OnceLock;
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::{Client, Method};

use crate::domain::plugin::{
    PluginHttpRequest, PluginHttpResponse, PLUGIN_HTTP_RESPONSE_MAX_BYTES, PLUGIN_HTTP_TIMEOUT_SECS,
};

/// 复用的 HTTP 客户端。
///
/// 客户端内部持有连接池：若每个请求都新建一个，「连续取同一站点的多个接口」会退化成
/// 每次重新握手。`OnceLock` 保证进程内只构造一次。
static CLIENT: OnceLock<Client> = OnceLock::new();

/// 发送请求并读取响应体。
///
/// 非 2xx 状态码不当成错误：调用外部接口时 4xx 往往带有插件需要读取的说明正文，
/// 把它变成异常会迫使插件再发一次相同请求。
pub async fn send(request: &PluginHttpRequest) -> Result<PluginHttpResponse, String> {
    let url = normalize_url(&request.url)?;
    let method = parse_method(request.method.as_deref())?;
    let headers = build_headers(request.headers.as_ref())?;

    let client = CLIENT.get_or_init(|| {
        Client::builder()
            .timeout(Duration::from_secs(PLUGIN_HTTP_TIMEOUT_SECS))
            .build()
            .unwrap_or_else(|_| Client::new())
    });

    let mut builder = client.request(method, &url).headers(headers);

    if let Some(body) = &request.body {
        builder = builder.body(body.clone());
    }

    let response = builder
        .send()
        .await
        .map_err(|error| format!("请求失败：{error}"))?;

    let status = response.status().as_u16();
    let response_headers = collect_headers(response.headers());

    // 先看声明长度：能在大体积响应下载前拒绝，就不必先把字节读进内存。
    if let Some(length) = response.content_length() {
        if length > PLUGIN_HTTP_RESPONSE_MAX_BYTES as u64 {
            return Err(format!(
                "响应体 {length} 字节，超过上限 {PLUGIN_HTTP_RESPONSE_MAX_BYTES} 字节"
            ));
        }
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("读取响应体失败：{error}"))?;

    // 声明长度可能缺失或与实际不符，真正读到的字节数才是最终判据。
    if bytes.len() > PLUGIN_HTTP_RESPONSE_MAX_BYTES {
        return Err(format!(
            "响应体 {} 字节，超过上限 {PLUGIN_HTTP_RESPONSE_MAX_BYTES} 字节",
            bytes.len()
        ));
    }

    Ok(PluginHttpResponse {
        body: String::from_utf8_lossy(&bytes).into_owned(),
        headers: response_headers,
        status,
    })
}

/// 校验并归一化目标地址。
///
/// 只放行 http / https：其余协议（`file:`、`data:` 等）在 HTTP 客户端里要么不被支持，
/// 要么语义完全不同，放进去只会把失败推迟到更难定位的地方。
fn normalize_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();

    if trimmed.is_empty() {
        return Err("请求地址为空".to_string());
    }

    let lowered = trimmed.to_ascii_lowercase();
    if !(lowered.starts_with("http://") || lowered.starts_with("https://")) {
        return Err("只支持 http / https 协议的请求".to_string());
    }

    Ok(trimmed.to_string())
}

/// 解析请求方法，缺省为 GET。
fn parse_method(raw: Option<&str>) -> Result<Method, String> {
    let Some(value) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(Method::GET);
    };

    Method::from_bytes(value.to_ascii_uppercase().as_bytes())
        .map_err(|_| format!("不支持的请求方法：{value}"))
}

/// 把插件给的请求头转成 reqwest 的头集合。
///
/// 逐个头做合法性校验而不是直接透传：非法头在发送时才报错的话，插件只会收到一句
/// 无从定位的网络错误。
fn build_headers(source: Option<&BTreeMap<String, String>>) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();

    let Some(source) = source else {
        return Ok(headers);
    };

    for (name, value) in source {
        let header_name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| format!("请求头名称不合法：{name}"))?;
        let header_value = HeaderValue::from_str(value)
            .map_err(|_| format!("请求头 {name} 的值不合法（可能含换行等控制字符）"))?;

        headers.insert(header_name, header_value);
    }

    Ok(headers)
}

/// 把响应头收敛成普通映射，同名头以逗号合并。
fn collect_headers(source: &HeaderMap) -> BTreeMap<String, String> {
    let mut merged: BTreeMap<String, String> = BTreeMap::new();

    for (name, value) in source {
        let key = name.as_str().to_string();
        let text = value.to_str().unwrap_or_default().to_string();

        merged
            .entry(key)
            .and_modify(|existing| {
                existing.push_str(", ");
                existing.push_str(&text);
            })
            .or_insert(text);
    }

    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_http_and_https_urls() {
        assert!(normalize_url("https://example.com/a").is_ok());
        assert!(normalize_url("  http://example.com  ").is_ok());
        assert_eq!(
            normalize_url("  http://example.com  ").expect("应被接受"),
            "http://example.com"
        );
    }

    #[test]
    fn rejects_non_http_schemes_and_blank_urls() {
        assert!(normalize_url("file:///c:/windows/win.ini").is_err());
        assert!(normalize_url("data:text/plain,hi").is_err());
        assert!(normalize_url("   ").is_err());
    }

    #[test]
    fn defaults_to_get_and_rejects_unknown_methods() {
        assert_eq!(parse_method(None).expect("缺省应为 GET"), Method::GET);
        assert_eq!(parse_method(Some("  ")).expect("空白应为 GET"), Method::GET);
        assert_eq!(
            parse_method(Some("post")).expect("应归一化为 POST"),
            Method::POST
        );
        assert!(parse_method(Some("NOT A METHOD")).is_err());
    }

    #[test]
    fn merges_duplicate_response_headers_with_comma() {
        let mut source = HeaderMap::new();
        source.append("set-cookie", HeaderValue::from_static("a=1"));
        source.append("set-cookie", HeaderValue::from_static("b=2"));

        let merged = collect_headers(&source);

        assert_eq!(merged.get("set-cookie").map(String::as_str), Some("a=1, b=2"));
    }
}
