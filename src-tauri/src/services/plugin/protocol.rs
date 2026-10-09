//! 插件页面资源协议。
//!
//! 插件界面由插件作者自己编写，宿主只负责把这些文件喂给插件窗口。URL 形状固定为
//! `/<插件id>/<包内相对路径>`。
//!
//! **多段形式是必需的**，不能图省事把整串路径塞进一段（`encodeURIComponent` 就会连
//! `/` 一起编码）：页面里的相对链接（`./settings.html`、`../shared/style.css`）是相对
//! 当前路径的目录解析的，单段路径会让它们丢掉插件 id，处理器就再也定位不到包目录。

use tauri::http::{header, Request, Response, StatusCode};
use tauri::utils::mime_type::MimeType;
use tauri::AppHandle;

use crate::infrastructure::filesystem::plugin_package;

use super::resolve_plugin_root;

/// 一次资源请求失败的原因，连同要回给 WebView 的状态码。
struct AssetFailure {
    message: String,
    status: StatusCode,
}

impl AssetFailure {
    fn bad_request(message: String) -> Self {
        Self {
            message,
            status: StatusCode::BAD_REQUEST,
        }
    }

    fn forbidden(message: String) -> Self {
        Self {
            message,
            status: StatusCode::FORBIDDEN,
        }
    }

    fn not_found(message: String) -> Self {
        Self {
            message,
            status: StatusCode::NOT_FOUND,
        }
    }
}

/// 处理插件窗口发起的一次资源请求。
///
/// 与 [`super::asset_base_url`] 是一套东西的两端：那边决定 URL 长什么样，这边负责把
/// 它解读回来。任何失败都收敛成一个响应而不是往上抛 —— WebView 只会把未处理的错误
/// 显示成一片空白，而状态码能让「文件不存在」与「越权被拦」在排查时区分得开。
pub fn handle_plugin_asset_request(
    app: &AppHandle,
    request: &Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    match resolve_asset(app, request) {
        Ok((relative_path, bytes)) => {
            // 内容嗅探优先、扩展名兜底：插件包里的无扩展名文件（`data`、`LICENSE`）
            // 只能靠内容判断。兜底刻意不取 HTML —— 一段未知二进制被当成 HTML 解析，
            // 只会让 WebView 对着一堆乱码排版，不如原样交给页面自己处理。
            let mime = MimeType::parse_with_fallback(&bytes, &relative_path, MimeType::OctetStream);

            build_response(StatusCode::OK, &mime, bytes)
        }
        Err(failure) => build_response(
            failure.status,
            "text/plain; charset=utf-8",
            failure.message.into_bytes(),
        ),
    }
}

/// 把请求 URL 解析成插件包内的一份资源。
fn resolve_asset(
    app: &AppHandle,
    request: &Request<Vec<u8>>,
) -> Result<(String, Vec<u8>), AssetFailure> {
    let requested_path = percent_decode(request.uri().path());

    // 形如 `/hello-dasktop/pages/settings.html`：第一段是插件 id，其余是包内相对路径。
    let trimmed = requested_path.trim_start_matches('/');

    let Some((plugin_id, relative_path)) = trimmed.split_once('/') else {
        return Err(AssetFailure::bad_request(format!(
            "插件资源地址缺少包内路径：{requested_path}"
        )));
    };

    if relative_path.is_empty() {
        return Err(AssetFailure::bad_request(format!(
            "插件资源地址缺少文件名：{requested_path}"
        )));
    }

    // 单独先判一次 id 合法性：`resolve_package_dir` 内部虽然也查，但它统一回「包不存在」，
    // 而 `../x` 这种 id 属于明确的越权尝试，值得单独给 403 以便和「插件没装」区分。
    if !plugin_package::is_valid_plugin_id(plugin_id) {
        return Err(AssetFailure::forbidden(format!("非法插件 id：{plugin_id}")));
    }

    let root = resolve_plugin_root(app).map_err(AssetFailure::not_found)?;
    let package_dir =
        plugin_package::resolve_package_dir(&root, plugin_id).map_err(AssetFailure::not_found)?;

    // 路径沙箱单独走一遍，把「越界」和「文件不存在」分成 403 / 404：两者混在一起的话，
    // 插件作者写错一个相对路径会被误读成安全拦截，反过来也一样。
    plugin_package::resolve_sandboxed_path(&package_dir, relative_path)
        .map_err(AssetFailure::forbidden)?;

    let bytes = plugin_package::read_package_asset(&package_dir, relative_path)
        .map_err(AssetFailure::not_found)?;

    Ok((relative_path.to_string(), bytes))
}

/// 组装响应。
fn build_response(status: StatusCode, content_type: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        // 资源就是磁盘上的文件，作者改完页面重开窗口就该看到新内容。少了这一条，
        // WebView 会拿着缓存继续显示旧页面，排查时极具误导性。
        .header(header::CACHE_CONTROL, "no-store")
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// 解码 URL 路径里的百分号转义。
///
/// 标准库没有这个能力，但插件作者完全可能给页面起中文名（`说明.html`），
/// 浏览器会把它编码成 `%E8%AF%B4%E6%98%8E.html` 再发出来。
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' {
            if let (Some(high), Some(low)) = (
                bytes.get(index + 1).copied().and_then(hex_digit),
                bytes.get(index + 2).copied().and_then(hex_digit),
            ) {
                decoded.push(high * 16 + low);
                index += 3;
                continue;
            }
        }

        decoded.push(bytes[index]);
        index += 1;
    }

    String::from_utf8_lossy(&decoded).into_owned()
}

/// 单个十六进制字符的数值；非法字符返回 `None`，由调用方按字面量保留。
fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_percent_escapes() {
        assert_eq!(percent_decode("/my-plugin/index.html"), "/my-plugin/index.html");
        assert_eq!(percent_decode("/my-plugin/a%20b.html"), "/my-plugin/a b.html");
        assert_eq!(
            percent_decode("/my-plugin/%E8%AF%B4%E6%98%8E.html"),
            "/my-plugin/说明.html"
        );
    }

    #[test]
    fn keeps_malformed_escapes_literal() {
        // 不完整的转义不能被吞掉：原样保留才能让「地址写错了」在 404 里看得出来，
        // 直接丢弃会变成一个看起来合法但不存在的路径。
        assert_eq!(percent_decode("/a%2"), "/a%2");
        assert_eq!(percent_decode("/a%zz.html"), "/a%zz.html");
    }
}
