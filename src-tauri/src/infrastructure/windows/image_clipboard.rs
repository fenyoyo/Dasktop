//! Windows 图片剪贴板读取：把剪贴板里的图片读成原始字节，供插件 `clipboard:read` 能力使用。
//!
//! 剪贴板里的「图片」有两种截然不同的形态，必须分别处理：
//!
//! 1. **位图**（CF_BITMAP）。截图工具（Win+Shift+S）、浏览器右键「复制图片」属于这一类。
//!    系统会在 CF_DIB / CF_DIBV5 与 CF_BITMAP 之间自动合成，所以只请求 CF_BITMAP 就能
//!    全部覆盖；拿到 HBITMAP 后交给 `common::bitmap` 用 GetDIBits 归一化成 32 位 RGBA，
//!    各种原位深（32/24/16/8/1）都不必自己解析 DIB 头，也不必处理 DIB 的行对齐与自下而上排列。
//!
//! 2. **图片文件**（CF_HDROP）。在资源管理器里对一张图片按 Ctrl+C 时，剪贴板里只有文件
//!    路径列表，没有位图数据——Windows 只在 CF_BITMAP ⇄ CF_DIB 之间自动转换，不会从文件
//!    列表合成位图。缺少这条分支的症状就是「明明复制了一张图，粘贴却提示剪贴板里没有图片」。
//!
//! 与 `text_clipboard.rs` 的分工：那个模块负责 CF_UNICODETEXT 文本，这里负责图片。
//!
//! 安全边界：这是唯一一条会按剪贴板内容去读磁盘的能力，因此刻意做了三重收窄——只取文件
//! 列表里的第一个文件、只读体积在上限内的文件、只放行魔数能识别为图片的格式。魔数不认识
//! 就当作「剪贴板里没有图片」，绝不按扩展名放行：扩展名可以随便改，放行非图片文件等于把
//! 任意文件塞给前端的 `<img>`。SVG 也被刻意排除，它本质是 XML，浏览器会按可执行文档处理。

#[cfg(target_os = "windows")]
use std::ffi::OsString;
#[cfg(target_os = "windows")]
use std::fs;
#[cfg(target_os = "windows")]
use std::io::Cursor;
#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStringExt;
#[cfg(target_os = "windows")]
use std::path::{Path, PathBuf};

#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Gdi::HBITMAP;
#[cfg(target_os = "windows")]
use windows::Win32::System::DataExchange::{EmptyClipboard, GetClipboardData};
#[cfg(target_os = "windows")]
use windows::Win32::System::Ole::{CF_BITMAP, CF_DIB, CF_HDROP};
#[cfg(target_os = "windows")]
use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

#[cfg(target_os = "windows")]
use crate::infrastructure::windows::common::bitmap::{to_rgba, RGBA_BYTES_PER_PIXEL};
#[cfg(target_os = "windows")]
use crate::infrastructure::windows::common::clipboard::{set_clipboard_hglobal, ClipboardSession};
#[cfg(target_os = "windows")]
use crate::infrastructure::windows::common::global_memory;
#[cfg(target_os = "windows")]
use crate::infrastructure::windows::common::png::encode_rgba;

/// 剪贴板位图的有效像素一律补成不透明。
///
/// 位图经 GetDIBits 以 32 位读出时，Alpha 通道多数情况下并不携带信息（截图工具写进
/// 剪贴板的 DIB 常常 Alpha 全为 0）。原样编码会得到一张全透明的 PNG，插件端 `<img>`
/// 看起来就是空白，所以在交给 PNG 编码前必须强制覆盖。
#[cfg(target_os = "windows")]
const OPAQUE_ALPHA: u8 = 255;

/// 从剪贴板读出的图片及其格式信息。
pub(crate) struct ClipboardImage {
    /// 可直接写进 data URL 的 MIME，由数据来源决定：位图分支固定 PNG，文件分支按魔数嗅探。
    pub(crate) mime: &'static str,
    /// 图片原始字节。位图分支是编码后的 PNG，文件分支是文件的原始字节。
    pub(crate) bytes: Vec<u8>,
    /// 文件分支的来源路径，仅供调用方写日志留痕；位图分支为 `None`。
    pub(crate) file_path: Option<String>,
}

/// 读取剪贴板里的图片。
///
/// `max_bytes` 是允许读取的图片体积上限：文件分支在动手读盘之前先看文件大小，位图分支在
/// 编码后校验，两处共用同一个上限，避免把超大图片读进内存再 base64 撑爆 IPC。
///
/// 剪贴板里是文本、或文件列表里的文件并非图片时返回 `Ok(None)`：这属于正常情况，
/// 由调用方决定提示文案，而不是当成读取失败。
///
/// 剪贴板位图句柄由系统持有，这里只读不释放——释放它会让剪贴板内容失效。
#[cfg(target_os = "windows")]
pub(crate) fn read_image(max_bytes: usize) -> Result<Option<ClipboardImage>, String> {
    let dropped_path = {
        let _clipboard = ClipboardSession::open()?;

        // 位图与文件列表同时存在时优先取位图：位图是用户当下看到的那份像素，
        // 文件列表可能只是复制动作顺带的产物（例如从浏览器拖拽留下的临时文件）。
        if let Some(png) = read_bitmap_png()? {
            if png.len() > max_bytes {
                return Err(oversized_error(max_bytes));
            }

            return Ok(Some(ClipboardImage {
                mime: "image/png",
                bytes: png,
                file_path: None,
            }));
        }

        first_dropped_path()
    };

    // 文件读取刻意放在剪贴板会话之外：读盘期间不再占着 OpenClipboard，
    // 否则读一张大图会一直挡着其它程序读写剪贴板。
    let Some(path) = dropped_path else {
        return Ok(None);
    };

    read_image_file(&path, max_bytes)
}

/// 把 CF_BITMAP 位图读成 PNG 字节；剪贴板里没有位图时返回 `None`。
#[cfg(target_os = "windows")]
fn read_bitmap_png() -> Result<Option<Vec<u8>>, String> {
    let handle = match unsafe { GetClipboardData(u32::from(CF_BITMAP.0)) } {
        Ok(handle) if !handle.is_invalid() => handle,
        // 没有位图格式（也未提供可自动转换的来源）时按「没有位图」处理。
        _ => return Ok(None),
    };

    let mut rgba = unsafe { to_rgba(HBITMAP(handle.0)) }
        .map_err(|error| format!("读取剪贴板位图失败：{error}"))?;

    for pixel in rgba.pixels.chunks_exact_mut(RGBA_BYTES_PER_PIXEL) {
        pixel[3] = OPAQUE_ALPHA;
    }

    let png = encode_rgba(rgba.width as u32, rgba.height as u32, &rgba.pixels)
        .map_err(|error| format!("编码剪贴板图片失败：{error}"))?;

    Ok(Some(png))
}

/// 取出文件列表（CF_HDROP）里的第一个文件路径；剪贴板里没有文件列表时返回 `None`。
///
/// 只取第一个：这个能力是为「复制一张图去解析」准备的，多选文件时没有明确语义，
/// 逐个读取只会放大磁盘访问面。
#[cfg(target_os = "windows")]
fn first_dropped_path() -> Option<PathBuf> {
    let handle = unsafe { GetClipboardData(u32::from(CF_HDROP.0)) }.ok()?;
    if handle.is_invalid() {
        return None;
    }

    let hdrop = HDROP(handle.0);

    // ifile 传 0xFFFFFFFF 且缓冲传 NULL 时，返回值是文件数量而非字符数——
    // 这是 DragQueryFileW 区分「问数量」与「问内容」的约定用法。
    if unsafe { DragQueryFileW(hdrop, u32::MAX, None) } == 0 {
        return None;
    }

    // 先问长度再取内容：路径可能超过 MAX_PATH，用固定缓冲会被静默截断，
    // 而截断后的路径可能指向另一个文件。
    let length = unsafe { DragQueryFileW(hdrop, 0, None) };
    if length == 0 {
        return None;
    }

    let mut buffer = vec![0_u16; length as usize + 1];
    let written = unsafe { DragQueryFileW(hdrop, 0, Some(&mut buffer)) };
    if written == 0 {
        return None;
    }

    // 用 OsString 承接而不是 String::from_utf16：Windows 路径允许出现不成对的代理项，
    // 按 UTF-16 严格解码会直接失败，等于把用户刚复制的那个文件丢掉。
    Some(PathBuf::from(OsString::from_wide(
        &buffer[..written as usize],
    )))
}

/// 读出文件列表里的第一个文件并识别为图片。
///
/// 魔数不认识就当作「剪贴板里没有图片」返回 `None`——用户复制的可能根本不是图片，
/// 这是正常情况，不该报成读取失败。
#[cfg(target_os = "windows")]
fn read_image_file(path: &Path, max_bytes: usize) -> Result<Option<ClipboardImage>, String> {
    let metadata =
        fs::metadata(path).map_err(|error| format!("读取剪贴板图片文件元信息失败：{error}"))?;

    if !metadata.is_file() {
        return Ok(None);
    }

    // 先看大小再读：超出上限的文件没必要整份读进内存。
    if metadata.len() > max_bytes as u64 {
        return Err(oversized_error(max_bytes));
    }

    let bytes = fs::read(path).map_err(|error| format!("读取剪贴板图片文件失败：{error}"))?;

    let Some(mime) = sniff_image_mime(&bytes) else {
        return Ok(None);
    };

    Ok(Some(ClipboardImage {
        mime,
        bytes,
        file_path: Some(path.display().to_string()),
    }))
}

/// 按文件头魔数判断图片类型，返回可直接写进 data URL 的 MIME。
///
/// 只认浏览器一定能渲染的栅格格式；不认识就返回 `None`，由调用方按「不是图片」处理。
#[cfg(target_os = "windows")]
fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }

    if bytes.starts_with(b"\xFF\xD8\xFF") {
        return Some("image/jpeg");
    }

    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }

    if bytes.starts_with(b"BM") {
        return Some("image/bmp");
    }

    // WebP 的文件头是 "RIFF" + 4 字节长度 + "WEBP"，中间 4 字节是长度，不能当作固定前缀匹配。
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }

    None
}

/// 体积超限的统一错误文案；位图分支与文件分支都用它，保证插件端看到同一种提示。
#[cfg(target_os = "windows")]
fn oversized_error(max_bytes: usize) -> String {
    format!("剪贴板图片超出上限（{max_bytes} 字节）")
}

/// 把 PNG 字节写入系统剪贴板（覆盖现有内容），供插件 `clipboard:write` 能力使用。
///
/// 写入走 **CF_DIB**（设备无关位图）而不是 CF_BITMAP：CF_DIB 的内存块自包含
/// （BITMAPINFOHEADER + 像素），不需要额外创建 GDI 位图对象，也避免了「谁负责释放
/// HBITMAP」的所有权问题。Windows 会在 CF_DIB ⇄ CF_BITMAP 之间自动合成，所以粘贴到
/// 画图、Word、微信等任何接受图片的应用都能正常拿到位图。
///
/// 像素统一写成 32 位 BGRA、自上而下（biHeight 取负）：
/// - 32 位省掉 24 位 DIB 必需的行填充（每行 4 字节对齐），拼接逻辑更直接；
/// - Alpha 强制补成不透明：截图类图片本就没有透明背景，而不少应用在处理 32 位 DIB 时
///   会把全 0 的 Alpha 当成透明，导致粘贴出来一片空白。
///
/// PNG 解码只做颜色扩展（EXPAND），不做尺寸缩放：插件提交的就是最终要粘贴的图，
/// 缩放会让用户以为「我截的是 A 怎么贴出来变模糊了」。
#[cfg(target_os = "windows")]
pub(crate) fn write_image(png_bytes: &[u8]) -> Result<(), String> {
    let (width, height, bgra) = decode_png_to_bgra(png_bytes)?;

    let dib = build_dib(width, height, &bgra);

    let _clipboard = ClipboardSession::open()?;
    unsafe {
        EmptyClipboard().map_err(|error| format!("无法清空系统剪贴板：{error}"))?;
    }

    let memory = global_memory::create_moveable_from_bytes(&dib, "无法创建图片剪贴板内存")?;
    // SetClipboardData 成功后 HGLOBAL 归系统所有，失败时由 set_clipboard_hglobal 内部释放。
    set_clipboard_hglobal(u32::from(CF_DIB.0), memory, "无法写入图片剪贴板")?;

    // dib 是函数内的局部 Vec，SetClipboardData 只拿走了全局内存中的那一份拷贝，
    // 此处正常返回后 dib 随函数栈回收，不会与系统持有的内存重复释放。
    Ok(())
}

/// 把 PNG 字节解码成 BGRA 像素（自上而下、每像素 4 字节、Alpha 强制不透明）。
#[cfg(target_os = "windows")]
fn decode_png_to_bgra(png_bytes: &[u8]) -> Result<(i32, i32, Vec<u8>), String> {
    let decoder = png::Decoder::new(Cursor::new(png_bytes));
    let mut reader = decoder
        .read_info()
        .map_err(|error| format!("PNG 解码失败：{error}"))?;

    let mut buffer = vec![0_u8; reader.output_buffer_size().unwrap_or(0)];
    let info = reader
        .next_frame(&mut buffer)
        .map_err(|error| format!("PNG 解码失败：{error}"))?;

    let width = info.width as i32;
    let height = info.height as i32;
    let samples = info.color_type.samples() as usize;
    let pixel_count = (width * height) as usize;
    let mut bgra = Vec::with_capacity(pixel_count * 4);

    for pixel in buffer[..info.buffer_size()].chunks_exact(samples) {
        bgra.push(pixel[2]);
        bgra.push(pixel[1]);
        bgra.push(pixel[0]);
        bgra.push(OPAQUE_ALPHA);
    }

    Ok((width, height, bgra))
}

/// 组装 CF_DIB 内存块：BITMAPINFOHEADER（32 位、自上而下）+ BGRA 像素。
///
/// `biHeight` 取负值表示自上而下，省去调用方翻行；`biSizeImage` 直接用像素总长，
/// 因为 32 位像素没有行填充。
#[cfg(target_os = "windows")]
fn build_dib(width: i32, height: i32, bgra: &[u8]) -> Vec<u8> {
    let mut dib = Vec::with_capacity(40 + bgra.len());

    dib.extend_from_slice(&(40u32).to_le_bytes());
    dib.extend_from_slice(&width.to_le_bytes());
    dib.extend_from_slice(&(-height).to_le_bytes());
    dib.extend_from_slice(&(1u16).to_le_bytes());
    dib.extend_from_slice(&(32u16).to_le_bytes());
    dib.extend_from_slice(&(0u32).to_le_bytes());
    dib.extend_from_slice(&(bgra.len() as u32).to_le_bytes());
    dib.extend_from_slice(&(0i32).to_le_bytes());
    dib.extend_from_slice(&(0i32).to_le_bytes());
    dib.extend_from_slice(&(0u32).to_le_bytes());
    dib.extend_from_slice(&(0u32).to_le_bytes());
    dib.extend_from_slice(bgra);

    dib
}

/// 非 Windows 平台没有 CF_BITMAP / CF_HDROP 语义，保持显式错误便于开发时定位平台差异。
#[cfg(not(target_os = "windows"))]
pub(crate) fn read_image(_max_bytes: usize) -> Result<Option<ClipboardImage>, String> {
    Err("当前平台暂不支持读取 Windows 剪贴板图片".to_string())
}

/// 非 Windows 平台不支持写入图片剪贴板。
#[cfg(not(target_os = "windows"))]
pub(crate) fn write_image(_png_bytes: &[u8]) -> Result<(), String> {
    Err("当前平台暂不支持写入 Windows 剪贴板图片".to_string())
}
