//! GDI 位图到 RGBA 像素的读取，供 Shell 图标渲染与剪贴板图片两条路径复用。
//!
//! 两条路径拿到的都是 HBITMAP，读像素的方式完全一致；差别只在拿到像素之后怎么用：
//! 图标要保留 Alpha（透明边缘靠它区分），剪贴板图片则必须把 Alpha 补成不透明
//! （截图工具写入的 32 位位图里 Alpha 通道通常没有意义）。所以这里只负责「读」，
//! 透明度语义交给调用方决定。

use std::io;
use std::mem::size_of;

use windows::Win32::Graphics::Gdi::{
    GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS,
    HBITMAP,
};

use crate::infrastructure::windows::common::error;

/// RGBA 每个像素占用的字节数。
pub(crate) const RGBA_BYTES_PER_PIXEL: usize = 4;
/// DIB 读取统一使用 32 位颜色深度，把各种原位深都归一化成 RGBA。
const BITMAP_COLOR_DEPTH_BITS: u16 = 32;
/// Windows DIB 位图平面数固定为 1。
const BITMAP_COLOR_PLANES: u16 = 1;

/// GDI 位图读出后的像素缓冲。
pub(crate) struct RgbaBitmap {
    /// 位图宽度（像素）。
    pub(crate) width: i32,
    /// 位图高度（像素）。
    pub(crate) height: i32,
    /// 自上而下、每像素 RGBA 四字节的像素数据。
    pub(crate) pixels: Vec<u8>,
}

/// 从 GDI 位图读取 32 位 RGBA 像素。
///
/// `biHeight` 取负值表示请求自上而下的 DIB，省去调用方翻行的步骤；`GetDIBits` 会把
/// 任意原位深（32/24/16/8/1）统一转换成 32 位输出，因此不必自己解析 DIB 头。
///
/// 只读不写：HBITMAP 的所有权仍在调用方（剪贴板位图由系统持有，绝不能在此释放）。
pub(crate) unsafe fn to_rgba(bitmap: HBITMAP) -> io::Result<RgbaBitmap> {
    if bitmap.is_invalid() {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "位图句柄无效"));
    }

    let mut bitmap_meta = BITMAP::default();
    let meta_size = GetObjectW(
        bitmap.into(),
        size_of::<BITMAP>() as i32,
        Some(&mut bitmap_meta as *mut _ as *mut _),
    );
    if meta_size == 0 {
        return Err(error::last_os_error("GetObjectW"));
    }

    let width = bitmap_meta.bmWidth;
    let height = bitmap_meta.bmHeight;
    if width <= 0 || height <= 0 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "位图尺寸非法"));
    }

    let mut bitmap_info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: BITMAP_COLOR_PLANES,
            biBitCount: BITMAP_COLOR_DEPTH_BITS,
            biCompression: 0,
            ..BITMAPINFOHEADER::default()
        },
        ..BITMAPINFO::default()
    };
    let mut bgra = vec![0_u8; width as usize * height as usize * RGBA_BYTES_PER_PIXEL];
    let device_context = GetDC(None);
    if device_context.is_invalid() {
        return Err(error::last_os_error("GetDC"));
    }

    let lines = GetDIBits(
        device_context,
        bitmap,
        0,
        height as u32,
        Some(bgra.as_mut_ptr() as *mut _),
        &mut bitmap_info,
        DIB_RGB_COLORS,
    );
    let _ = ReleaseDC(None, device_context);
    if lines == 0 {
        return Err(error::last_os_error("GetDIBits"));
    }

    // GetDIBits 按 BGR(A) 排列输出，交换首尾通道即可得到浏览器与 PNG 使用的 RGBA。
    let mut rgba = bgra;
    for pixel in rgba.chunks_exact_mut(RGBA_BYTES_PER_PIXEL) {
        pixel.swap(0, 2);
    }

    Ok(RgbaBitmap {
        width,
        height,
        pixels: rgba,
    })
}
