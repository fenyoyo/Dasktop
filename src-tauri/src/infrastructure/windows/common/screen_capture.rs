//! 屏幕区域截图。
//!
//! 插件要识别屏幕上的二维码，可 WebView 拿不到屏幕像素——浏览器的同源与权限模型
//! 根本不给网页读屏的通道。于是只能由宿主的 GDI 通道代劳：把「显示器物理坐标上的
//! 一个矩形」读成像素，再编码成 PNG 的 base64 字符串交回插件。
//!
//! 这里刻意不做坐标换算、不建窗口、不涉及交互：截图范围由服务层在用户完成框选后
//! 给出，本模块只负责「给定矩形 → PNG 数据」这段纯像素搬运，因此它可以被单独验证，
//! 也不会把窗口与鼠标的复杂度缠进像素处理里。

/// 每像素 BGRA 四个字节。
#[cfg(target_os = "windows")]
const BYTES_PER_PIXEL: i32 = 4;
/// DIB 读取统一用 32 位色深，读出来即为 BGRA。
#[cfg(target_os = "windows")]
const BITMAP_COLOR_DEPTH_BITS: u16 = 32;
/// DIB 位图平面数固定为 1。
#[cfg(target_os = "windows")]
const BITMAP_COLOR_PLANES: u16 = 1;
/// 屏幕位图没有可用的 Alpha 通道（BitBlt 会把它写 0），位图读回后统一按完全不透明处理。
#[cfg(target_os = "windows")]
const OPAQUE_ALPHA: u8 = 255;

/// 截取屏幕指定矩形，返回 PNG 的 base64 字符串。
///
/// 坐标是**物理像素**，以虚拟屏幕左上角为原点：多显示器时左侧屏幕的 x 可以是负数，
/// 与 `GetDC(None)` 的坐标系一致。调用方（服务层）拿到的显示器矩形同样是物理像素，
/// 因此这里不做任何 DPI 换算——换算是窗口那一层的事，混进来只会出现两处各算一次
/// 且结果不一致的偏差。
///
/// 返回 base64 而不是原始字节，是为了让它能直接嵌进命令的 JSON 返回值；插件侧拿到后
/// 拼上 `data:image/png;base64,` 就能喂给 `<img>` 或 canvas。
#[cfg(target_os = "windows")]
pub(crate) fn capture_region_base64(
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<String, String> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;

    use crate::infrastructure::windows::common::png::encode_rgba;

    if width <= 0 || height <= 0 {
        return Err("截图区域尺寸无效".to_owned());
    }

    let pixels = windows_impl::capture_region_rgba(x, y, width, height)?;

    let png_bytes = encode_rgba(width as u32, height as u32, &pixels)
        .map_err(|error| format!("截图编码 PNG 失败：{error}"))?;

    Ok(STANDARD.encode(png_bytes))
}

/// 非 Windows 平台不提供屏幕截图通道。
#[cfg(not(target_os = "windows"))]
pub(crate) fn capture_region_base64(
    _x: i32,
    _y: i32,
    _width: i32,
    _height: i32,
) -> Result<String, String> {
    Err("屏幕截图仅支持 Windows 平台".to_owned())
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use std::mem::size_of;

    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, HBITMAP,
        HDC, SRCCOPY,
    };

    use super::{BITMAP_COLOR_DEPTH_BITS, BITMAP_COLOR_PLANES, BYTES_PER_PIXEL, OPAQUE_ALPHA};

    /// 从屏幕读取矩形区域，返回 RGBA 顺序的像素缓冲。
    pub(super) fn capture_region_rgba(
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    ) -> Result<Vec<u8>, String> {
        // SAFETY: 三个 GDI 句柄（屏幕 DC、内存 DC、位图）都在本函数内成对创建与释放，
        // 且每条错误返回路径都先归还已获取的句柄再返回，不存在泄漏；`previous` 是
        // SelectObject 换出的原对象，画完后原样换回，内存 DC 被回收时状态干净。
        unsafe {
            let screen_dc = GetDC(None);
            if screen_dc.is_invalid() {
                return Err("获取屏幕设备上下文失败".to_owned());
            }

            let memory_dc = CreateCompatibleDC(Some(screen_dc));
            if memory_dc.is_invalid() {
                let _ = ReleaseDC(None, screen_dc);
                return Err("创建内存设备上下文失败".to_owned());
            }

            let bitmap = CreateCompatibleBitmap(screen_dc, width, height);
            if bitmap.is_invalid() {
                let _ = DeleteDC(memory_dc);
                let _ = ReleaseDC(None, screen_dc);
                return Err("创建屏幕位图失败".to_owned());
            }

            let previous = SelectObject(memory_dc, bitmap.into());

            // 把屏幕 DC 上目标矩形像素拷进内存位图；x / y 用屏幕物理坐标，可为负数。
            // 只拷用户框选的那块而不是整屏，既省内存也省掉后续的裁剪步骤。
            let result = match BitBlt(memory_dc, 0, 0, width, height, Some(screen_dc), x, y, SRCCOPY)
            {
                Ok(()) => read_bitmap_rgba(screen_dc, bitmap, width, height),
                Err(error) => Err(format!("拷贝屏幕像素失败：{error}")),
            };

            let _ = SelectObject(memory_dc, previous);
            let _ = DeleteObject(bitmap.into());
            let _ = DeleteDC(memory_dc);
            let _ = ReleaseDC(None, screen_dc);

            result
        }
    }

    /// 读取位图像素并转成浏览器使用的 RGBA 顺序。
    ///
    /// 请求的是 32 位 DIB：GDI 回填的通道顺序是 BGRA，且 Alpha 由 BitBlt 写成 0，
    /// 因此这里既要做红蓝交换，也要把 Alpha 补成不透明——否则 PNG 会整张透明，
    /// 前端看起来就是「截了个空白」。
    unsafe fn read_bitmap_rgba(
        device_context: HDC,
        bitmap: HBITMAP,
        width: i32,
        height: i32,
    ) -> Result<Vec<u8>, String> {
        let mut bitmap_info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                // 负高度表示自上而下存储，省去读回后再做一次整行翻转。
                biHeight: -height,
                biPlanes: BITMAP_COLOR_PLANES,
                biBitCount: BITMAP_COLOR_DEPTH_BITS,
                // BI_RGB：不压缩，按每像素 4 字节直接回填。
                biCompression: 0,
                ..BITMAPINFOHEADER::default()
            },
            ..BITMAPINFO::default()
        };

        let mut pixels = vec![0_u8; (width * height * BYTES_PER_PIXEL) as usize];

        let lines = GetDIBits(
            device_context,
            bitmap,
            0,
            height as u32,
            Some(pixels.as_mut_ptr() as *mut _),
            &mut bitmap_info,
            DIB_RGB_COLORS,
        );

        if lines == 0 {
            return Err("读取屏幕像素失败".to_owned());
        }

        for pixel in pixels.chunks_exact_mut(BYTES_PER_PIXEL as usize) {
            pixel.swap(0, 2);
            pixel[3] = OPAQUE_ALPHA;
        }

        Ok(pixels)
    }
}
