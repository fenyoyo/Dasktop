//! 像素缓冲与 PNG 字节之间的双向转换。
//!
//! **编码方向**：宿主有两处要把内存里的像素交给浏览器——Shell 图标缩略图
//! （`shell_icon::bitmap`）与插件的屏幕截图（`common::screen_capture`）。两处的输入都是
//! RGBA 缓冲，输出都必须是浏览器 `<img>` 能直接渲染的 PNG，编码参数（8 位深、RGBA 色彩
//! 类型）也必须一致，因此把编码收在一处：否则两处各自设参数，很容易出现一边带 Alpha
//! 一边不带的偏差，表现为「图片能显示但边缘发黑」这类只在特定素材上暴露的问题。
//!
//! **解码方向**：目前只有插件图标一处——窗口任务栏图标只接受原始 RGBA 像素，
//! 需要把包内 PNG 文件还原成缓冲，见 [`decode_png_to_rgba`]。

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

/// 把 PNG 字节解码为 8 位 RGBA 像素，返回 `(像素, 宽, 高)`。
///
/// 插件清单里的 `icon` 字段指向包内 PNG 文件，建窗时需要把字节还原成 RGBA 缓冲
/// 才能调 `WebviewWindowBuilder::icon()`（它只接受原始像素，不接受编码后的文件）。
/// 统一走这里解码，避免调用方各自处理调色板展开、灰度转换、位深归一等琐碎差异。
///
/// # 为什么显式指定变换
///
/// 解码器默认不做任何展开（`Transformations::IDENTITY`）：调色板图会原样输出索引值、
/// 16 位图会输出 `u16` 采样、灰度图只有单通道。而窗口图标要的是紧密排列的 8 位 RGBA，
/// 直接把这种缓冲交出去会得到一张偏色或错位的图。这里让解码器替我们做完展开，
/// 调用方就只需要关心「通道数补齐」这一件事。
pub(crate) fn decode_png_to_rgba(png_bytes: &[u8]) -> Result<(Vec<u8>, u32, u32), String> {
    use png::{Decoder, Transformations};
    use std::io::Cursor;

    let mut decoder = Decoder::new(Cursor::new(png_bytes));
    // EXPAND：调色板 / 低位深展开到 8 位，tRNS 展开成 alpha；STRIP_16：16 位降为 8 位。
    decoder.set_transformations(Transformations::EXPAND | Transformations::STRIP_16);
    let mut reader = decoder
        .read_info()
        .map_err(|e| format!("PNG 文件头解析失败：{e}"))?;
    let buffer_size = reader
        .output_buffer_size()
        .ok_or("PNG 未报告输出缓冲区大小")?;
    let mut buffer = vec![0u8; buffer_size];
    let info = reader
        .next_frame(&mut buffer)
        .map_err(|e| format!("PNG 像素数据解析失败：{e}"))?;

    // 非 RGBA 格式（灰度、调色板、RGB 无透明通道）统一展开为 RGBA，
    // 否则不同来源的 PNG 会因为通道数差异导致图标偏色或透明区变黑。
    let rgba = match info.color_type {
        ColorType::Rgba => buffer[..info.buffer_size()].to_vec(),
        ColorType::Rgb => {
            let src = &buffer[..info.buffer_size()];
            let mut dst = Vec::with_capacity((info.width * info.height * 4) as usize);
            for chunk in src.chunks_exact(3) {
                dst.extend_from_slice(chunk);
                dst.push(255);
            }
            dst
        }
        ColorType::Grayscale => {
            let src = &buffer[..info.buffer_size()];
            let mut dst = Vec::with_capacity((info.width * info.height * 4) as usize);
            for &v in src {
                dst.extend_from_slice(&[v, v, v, 255]);
            }
            dst
        }
        ColorType::GrayscaleAlpha => {
            let src = &buffer[..info.buffer_size()];
            let mut dst = Vec::with_capacity((info.width * info.height * 4) as usize);
            for chunk in src.chunks_exact(2) {
                dst.extend_from_slice(&[chunk[0], chunk[0], chunk[0], chunk[1]]);
            }
            dst
        }
        // 调色板图已被上面的 EXPAND 变换展开成 RGB / RGBA，走到这里说明解码器行为变了。
        ColorType::Indexed => {
            return Err("调色板 PNG 未被展开，请改用 RGBA 格式".into());
        }
    };

    Ok((rgba, info.width, info.height))
}
