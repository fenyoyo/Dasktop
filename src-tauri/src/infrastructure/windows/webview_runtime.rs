//! WebView2 运行时级启动参数。
//!
//! 这里只放「必须在 WebView2 环境创建之前、且在进程范围内生效」的参数。
//! Dasktop 目前只有一项：关闭 Chromium 的原生窗口遮挡检测（见
//! `apply_browser_arguments` 的说明）。

/// WebView2 加载器读取的「追加浏览器参数」环境变量。
#[cfg(windows)]
const WEBVIEW2_BROWSER_ARGUMENTS_ENV: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";

/// Tauri / wry 默认传给 WebView2 的 `--disable-features` 列表。
///
/// 见 `tauri-utils` 中 `WindowConfig::additional_browser_args` 的文档：
/// 「By default wry passes `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`
/// so if you set this, you also need to disable these components by yourself if you want.」
#[cfg(windows)]
const TAURI_DEFAULT_DISABLED_FEATURES: &str = "msWebOOUI,msPdfOOUI,msSmartScreenProtection";

/// Chromium 的「原生窗口遮挡检测」特性名。
#[cfg(windows)]
const NATIVE_WINDOW_OCCLUSION_FEATURE: &str = "CalculateNativeWinOcclusion";

/// 除 `--disable-features` 之外还要追加的独立开关。
///
/// Chromium 让「被遮挡窗口停止出帧」其实有**两条并行机制**，只关掉其中一条不足以
/// 让窗口持续出帧：
///
/// 1. `CalculateNativeWinOcclusion`（feature）——决定是否调用 Win32 的原生遮挡判定；
/// 2. `--disable-backgrounding-occluded-windows`（独立 switch）——遮挡判定成立后
///    是否把该窗口后台化（降级甚至暂停其合成节奏）。
///
/// Box 常驻桌面层、长期被应用窗口完全盖住，正是这两条机制的命中场景。补充执行：
/// `--disable-renderer-backgrounding` 关闭渲染进程级的后台化，避免渲染进程被整体降级。
#[cfg(windows)]
const EXTRA_BROWSER_SWITCHES: &[&str] = &[
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
];

/// 关闭 Chromium 的「窗口被遮挡后停止出帧」行为。
///
/// # 要解决的问题
///
/// Box 常驻「桌面层」时位于 `HWND_BOTTOM`——所有应用窗口之下、桌面图标之上，
/// 日常会被其它应用窗口完全盖住。而 Windows 上 Chromium 的遮挡检测**只按窗口矩形
/// 判断是否被遮挡、不考虑透明度**，于是把 Box 判定为「已完全遮挡」并停止为该窗口
/// 出帧（这是浏览器省电的正常设计）。
///
/// 按下 Win+D 的瞬间 Box 被搬到桌面之上、重新可见，但 Chromium 还来不及提交新帧，
/// DWM 只能拿空表面合成 —— 观感上就是「非常快速地黑闪一下」。反向操作（再按一次
/// Win+D，Box 重新被盖住）不需要新帧，所以不闪，这与用户观察到的现象一致。
/// 同样的根因也表现为业界常见的「WebView2 窗口打开后一片空白，点一下才出现内容」。
///
/// # 为什么用环境变量而不是 `additional_browser_args`
///
/// Box 窗口由前端 `new WebviewWindow(...)` 动态创建，而 Tauri 2.11 前端窗口选项
/// **不透出** `additional_browser_args`（只有 Rust 侧 `WebviewWindowBuilder` 才有）。
/// `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 由 WebView2 加载器读取，是当前唯一能覆盖
/// 动态创建窗口的入口。
///
/// # 为什么必须写全 `--disable-features` 列表
///
/// Chromium 对重复的 `--disable-features` switch 取**最后一个**。若这里只写本项，
/// 一旦它排在 Tauri 默认值之后就会把 `msWebOOUI` 等三项挤掉。故这里显式带上
/// `TAURI_DEFAULT_DISABLED_FEATURES`，无论最终哪一份生效都包含全部所需项。
///
/// # 代价
///
/// 窗口被遮挡时 Chromium 仍保持渲染管线活跃，空闲期 GPU/CPU 占用略高于默认行为。
/// Box 内容基本静止，实际增量很小。
#[cfg(windows)]
pub(crate) fn apply_browser_arguments() {
    let mut requested = format!(
        "--disable-features={TAURI_DEFAULT_DISABLED_FEATURES},{NATIVE_WINDOW_OCCLUSION_FEATURE}"
    );
    for switch in EXTRA_BROWSER_SWITCHES {
        requested.push(' ');
        requested.push_str(switch);
    }

    let merged = match std::env::var(WEBVIEW2_BROWSER_ARGUMENTS_ENV) {
        Ok(existing) if !existing.trim().is_empty() => {
            // 调用方（CI / 排障）已显式配置过：只补缺失项，不整段覆盖。
            let has_occlusion_feature = existing.contains(NATIVE_WINDOW_OCCLUSION_FEATURE);
            let has_all_switches = EXTRA_BROWSER_SWITCHES
                .iter()
                .all(|switch| existing.contains(switch));
            if has_occlusion_feature && has_all_switches {
                return;
            }
            format!("{existing} {requested}")
        }
        _ => requested,
    };

    std::env::set_var(WEBVIEW2_BROWSER_ARGUMENTS_ENV, merged);
}

/// 非 Windows 平台没有 WebView2，无需处理。
#[cfg(not(windows))]
pub(crate) fn apply_browser_arguments() {}
