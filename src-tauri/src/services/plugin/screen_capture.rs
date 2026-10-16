//! 插件屏幕截图的能力编排。
//!
//! 一次「截屏取图」在宿主侧是四步：验过插件声明的 `screen:capture` 权限 → 在鼠标
//! 所在显示器上弹出一层透明框选窗口 → 等用户拖出一个矩形 → 用 GDI 把那个矩形截成
//! PNG 交回插件。第一步由 [`super::require_permission`] 完成，后三步在本模块。
//!
//! # 为什么框选层是一张透明窗口，而不是「先截全屏再让前端显示」
//!
//! 后者要把整屏 PNG（几 MB）通过 IPC 送进覆盖页，页面显示出来后再裁一次，最后
//! 再把裁剪结果传回去——数据在两端之间来回跑了两趟。而透明窗口下方就是真实桌面，
//! 用户框选时看到的是实时画面，宿主只需等四个数字（选区矩形），拿到后再对真实屏幕
//! 做一次 BitBlt。数据量从「整屏图片」降到「一个矩形」，链路短且没有中间副本。
//!
//! # 坐标口径
//!
//! 覆盖页是普通网页，它给出的选区是 CSS 像素（相对覆盖窗口视口）。覆盖窗口被精确
//! 定位成目标显示器的物理矩形，因此「CSS 像素 × 显示器缩放」再加显示器物理原点，
//! 就是屏幕物理坐标。这段换算只在 [`to_physical_region`] 做一次，下层
//! `common::screen_capture` 拿到的已经是屏幕物理坐标，不再二次换算。

use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;

use serde::Deserialize;
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};

use crate::domain::plugin::{PLUGIN_PERMISSION_SCREEN_CAPTURE, SCREEN_CAPTURE_OVERLAY_WINDOW_LABEL};
use crate::infrastructure::windows::common::screen_capture;

use super::{append_log, require_permission};

/// 框选覆盖页相对前端产物根目录的路径。
///
/// 开发态解析到 Vite dev server，打包后解析到 `dist/`；两侧都由 `vite.config.ts`
/// 的多入口配置产出，路径写成同一个相对名是这条约定成立的前提。
const SCREEN_CAPTURE_OVERLAY_PAGE: &str = "capture-overlay.html";

/// 允许被截取的最小选区边长（CSS 像素）。
///
/// 小于它的选区通常是用户误触：点一下就松手会得到一个 0×0 的空选区，直接拿去
/// BitBlt 会创建一张零尺寸位图。这里把它挡在换算之前，让「误触」表现为取消而不是报错。
const MIN_SELECTION_EDGE: f64 = 2.0;

/// 覆盖页回传的选区，坐标是相对覆盖窗口视口的 CSS 像素。
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenCaptureSelection {
    /// 选区左上角相对视口的水平偏移。
    pub x: f64,
    /// 选区左上角相对视口的垂直偏移。
    pub y: f64,
    /// 选区宽度。
    pub width: f64,
    /// 选区高度。
    pub height: f64,
}

/// 等待中的框选会话。
///
/// 只保存「怎么把结果送回等待者」这一样东西：显示器与缩放由发起截图的命令自己持有，
/// 换算不再依赖共享状态，会话状态因此可以只活到结果送达为止。
struct PendingCapture {
    /// 把选区送回 [`capture_screen_region`] 的等待端；`None` 表示用户取消。
    respond: Sender<Option<ScreenCaptureSelection>>,
}

/// 屏幕框选会话的全局状态。
///
/// 同一时刻只允许一个：覆盖窗口是置顶全屏的，叠两个会让用户分不清在框哪一层，而且
/// 两个等待端都挂在同一个窗口的关闭事件上，谁被唤醒完全随机。
#[derive(Default)]
pub struct ScreenCaptureSession(Mutex<Option<PendingCapture>>);

/// 弹出框选层并截取用户选中的屏幕区域，返回 PNG 的 base64；用户取消时返回 `None`。
///
/// 光标位置由命令层读取后传入：这里刻意不接收 `Window`，好让「弹窗 → 等待 → 截图」
/// 这段异步流程不持有窗口句柄，避免调用方窗口在等待期间被关闭时出现悬垂引用。
pub async fn capture_screen_region(
    app: &AppHandle,
    plugin_id: &str,
    cursor: PhysicalPosition<f64>,
) -> Result<Option<String>, String> {
    require_permission(app, plugin_id, PLUGIN_PERMISSION_SCREEN_CAPTURE)?;

    let monitor = app
        .monitor_from_point(cursor.x, cursor.y)
        .map_err(|error| format!("定位鼠标所在显示器失败：{error}"))?
        .ok_or_else(|| "未能确定鼠标所在的显示器".to_owned())?;

    let monitor_position = *monitor.position();
    let monitor_size = *monitor.size();
    let scale_factor = monitor.scale_factor();

    let (sender, receiver) = channel::<Option<ScreenCaptureSelection>>();
    begin_session(app, sender)?;

    if let Err(error) = open_overlay_window(app, monitor_position, monitor_size) {
        // 建窗失败时把占位撤掉，否则用户再点一次会一直被告知「已有一个框选在进行」。
        let _ = take_pending(app);
        return Err(error);
    }

    // 等待用户操作。`recv` 是阻塞调用，放到 blocking 池上跑，避免占住 async worker。
    let selection = match tauri::async_runtime::spawn_blocking(move || receiver.recv()).await {
        Ok(Ok(selection)) => selection,
        Ok(Err(error)) => {
            end_session(app);
            return Err(format!("等待框选结果失败：{error}"));
        }
        Err(error) => {
            end_session(app);
            return Err(format!("等待框选结果失败：{error}"));
        }
    };

    end_session(app);

    let Some(selection) = selection else {
        // 用户取消不是错误：插件侧应当把它当成「这次没截」而不是「能力坏了」。
        return Ok(None);
    };

    let (x, y, width, height) =
        to_physical_region(selection, monitor_position, scale_factor)?;

    append_log(
        app,
        plugin_id,
        "screen",
        &format!("截取屏幕区域 {width}×{height}"),
    )?;

    screen_capture::capture_region_base64(x, y, width, height).map(Some)
}

/// 结束框选：由覆盖页在用户松开鼠标后调用，把选区交回等待者。
pub fn finish_screen_capture(app: &AppHandle, selection: ScreenCaptureSelection) -> Result<(), String> {
    let pending = take_pending(app).ok_or_else(|| "没有正在进行的屏幕框选".to_owned())?;

    close_overlay_window(app);

    pending
        .respond
        .send(Some(selection))
        .map_err(|_| "框选结果已无人接收".to_owned())
}

/// 取消框选：由覆盖页在用户按 Esc / 右键时调用。
///
/// 覆盖窗口被关闭时也会走到这里（见 [`open_overlay_window`] 的关闭钩子），因此
/// 用户走非常规路径关掉窗口同样不会让等待端永远挂着。
pub fn cancel_screen_capture(app: &AppHandle) {
    let Some(pending) = take_pending(app) else {
        return;
    };

    close_overlay_window(app);
    // 等待端被丢弃说明命令侧已经先行退出，这不是错误，忽略发送结果。
    let _ = pending.respond.send(None);
}

/* -------------------------------------------------------------------------- */
/* 会话状态                                                                    */
/* -------------------------------------------------------------------------- */

/// 占住会话槽位并把等待端登记进去。
fn begin_session(app: &AppHandle, respond: Sender<Option<ScreenCaptureSelection>>) -> Result<(), String> {
    let session = app.state::<ScreenCaptureSession>();
    let mut pending = session
        .0
        .lock()
        .map_err(|_| "屏幕框选会话状态不可用".to_owned())?;

    if pending.is_some() {
        return Err("已有一个屏幕框选正在进行".to_owned());
    }

    *pending = Some(PendingCapture { respond });
    Ok(())
}

/// 取出等待端并清空槽位；没有会话时返回 `None`。
fn take_pending(app: &AppHandle) -> Option<PendingCapture> {
    let session = app.state::<ScreenCaptureSession>();

    session.0.lock().ok().and_then(|mut pending| pending.take())
}

/// 结束会话并关闭覆盖窗口，重复调用无副作用。
fn end_session(app: &AppHandle) {
    let _ = take_pending(app);
    close_overlay_window(app);
}

/* -------------------------------------------------------------------------- */
/* 覆盖窗口                                                                    */
/* -------------------------------------------------------------------------- */

/// 在目标显示器上弹出透明框选层。
///
/// 窗口先以 `visible(false)` 建出来，定位与尺寸落定后再显示：先显示再移动会闪一下
/// 默认位置，用户看到的就是「框选层从别处跳到我这块屏」。
fn open_overlay_window(
    app: &AppHandle,
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
) -> Result<(), String> {
    let label = SCREEN_CAPTURE_OVERLAY_WINDOW_LABEL;

    if app.get_webview_window(label).is_some() {
        return Err("屏幕框选层已存在".to_owned());
    }

    let window = WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::App(SCREEN_CAPTURE_OVERLAY_PAGE.into()),
    )
    .title("")
    .decorations(false)
    .resizable(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .focused(true)
    .build()
    .map_err(|error| format!("创建屏幕框选层失败：{error}"))?;

    // 位置与尺寸用物理像素直接设定：builder 的 position 只接受逻辑坐标，而多显示器
    // 下「逻辑坐标 ↔ 物理坐标」的换算受各屏 DPI 影响，绕一圈反而容易定位偏差，
    // 表现为覆盖层没有精确盖住目标显示器、框选坐标整体偏移。
    window
        .set_position(tauri::Position::Physical(position))
        .map_err(|error| format!("屏幕框选层定位失败：{error}"))?;
    window
        .set_size(tauri::Size::Physical(size))
        .map_err(|error| format!("屏幕框选层尺寸设置失败：{error}"))?;

    // 兜底退出路径：框选层没有标题栏，用户按 Alt+F4 或系统强行关闭时不会走
    // finish / cancel 命令，等待端会永远挂着。窗口销毁事件里补一次取消即可。
    let handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            cancel_screen_capture(&handle);
        }
    });

    window
        .show()
        .map_err(|error| format!("屏幕框选层显示失败：{error}"))?;

    // 框选依赖键盘（Esc 取消）与鼠标，必须拿到焦点。
    window
        .set_focus()
        .map_err(|error| format!("屏幕框选层聚焦失败：{error}"))?;

    Ok(())
}

/// 关闭覆盖窗口；窗口不存在时静默返回。
fn close_overlay_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(SCREEN_CAPTURE_OVERLAY_WINDOW_LABEL) {
        let _ = window.close();
    }
}

/* -------------------------------------------------------------------------- */
/* 坐标换算                                                                    */
/* -------------------------------------------------------------------------- */

/// 把覆盖页的 CSS 像素选区换算成屏幕物理坐标的 `(x, y, width, height)`。
///
/// 换算依据是「覆盖窗口恰好等于目标显示器的物理矩形」这一点：视口左上角对应显示器
/// 物理原点，视口内每个 CSS 像素对应 `scale_factor` 个物理像素。四舍五入只会带来
/// 一个像素以内的偏差，对识别二维码没有影响。
fn to_physical_region(
    selection: ScreenCaptureSelection,
    monitor_position: PhysicalPosition<i32>,
    scale_factor: f64,
) -> Result<(i32, i32, i32, i32), String> {
    if selection.width < MIN_SELECTION_EDGE || selection.height < MIN_SELECTION_EDGE {
        return Err("框选范围过小".to_owned());
    }

    let x = monitor_position.x as f64 + selection.x * scale_factor;
    let y = monitor_position.y as f64 + selection.y * scale_factor;
    let width = selection.width * scale_factor;
    let height = selection.height * scale_factor;

    Ok((
        x.round() as i32,
        y.round() as i32,
        width.round().max(1.0) as i32,
        height.round().max(1.0) as i32,
    ))
}
