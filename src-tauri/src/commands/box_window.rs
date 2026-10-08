use crate::services::app;
use tauri::AppHandle;

/// Box 窗口固定为「置顶 + 免疫 Win+D」，保证显示桌面时 Box 保持可见。
///
/// 失败时服务层已降级为普通顶层窗口并记录日志，这里返回 Ok 保持前端流程无感。
#[tauri::command]
pub fn glue_box_window_to_desktop(app: AppHandle, window_label: String) -> Result<(), String> {
    app::box_window_glue::glue_box_window_to_desktop(&app, &window_label)
}
