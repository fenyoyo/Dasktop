//! RGBA 像素转 PNG 字节的编码工具。
//!
//! 宿主有两处要把内存里的像素交给浏览器：Shell 图标缩略图（`shell_icon::bitmap`）与
//! 插件的屏幕截图（`common::screen_capture`）。两处的输入都是 RGBA 缓冲，输出都必须是
//! 浏览器 `<img>` 能直接渲染的 PNG，编码参数（8 位深、RGBA 色彩类型）也必须一致，
//! 因此把编码收在一处：否则两处各自设参数，很容易出现一边带 Alpha 一边不带的偏差，
//! 表现为「图片能显示但边缘发黑」这类只在特定素材上暴露的问题。

use std::io;

use png::{BitDepth, ColorType, Encoder};

use crate::infrastructure::windows::common::error;

/// 把 RGBA 像素编码为 PNG 字节。
///
/// `rgba` 的长度必须是 `width * height * 4`，由调用方保证——这里的两个来源
/// （图标位图、屏幕位图）都是按这个口径读取的，重复校验只会掩盖真正的读取错误。
pub(crate) fn encode_rgba(width: u32, height: u32, rgba: &[u8]) -> io::Result<Vec<u8>> {
    let mut png_bytes = Vec::new();
    {
        let mut encoder = Encoder::new(&mut png_bytes, width, height);
        encoder.set_color(ColorType::Rgba);
        encoder.set_depth(BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(error::io_other)?;
        writer.write_image_data(rgba).map_err(error::io_other)?;
    }

    Ok(png_bytes)
}
