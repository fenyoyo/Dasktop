//! Windows 原生「另存为」对话框封装，供插件把生成的内容导出到用户亲手选定的位置。
//!
//! 与 `folder_dialog` 拆成两个模块而不是合成一个：两者的返回值、失败语义与用途都不同
//! （选目录 / 选文件），合在一起只会让调用方去猜「这个函数到底弹的是哪种框」。

#[cfg(target_os = "windows")]
use std::path::Path;

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::HWND;

/// 用户在保存对话框里点「取消」时 Shell 返回的 HRESULT，属于正常结果而不是错误。
#[cfg(target_os = "windows")]
const HRESULT_ERROR_CANCELLED: i32 = 0x800704C7_u32 as i32;

/// 保存对话框窗口所属句柄类型，命令层负责从 Tauri 窗口中提取。
#[cfg(target_os = "windows")]
pub(crate) type SaveDialogOwner = HWND;

/// 非 Windows 平台没有当前产品目标里的原生保存对话框语义，保留同名类型简化调用方分支。
#[cfg(not(target_os = "windows"))]
pub(crate) type SaveDialogOwner = ();

/// 弹出系统保存对话框并返回用户选定的完整路径；用户取消时返回 `None`。
///
/// 只负责「问到路径」，不负责写文件：体积校验与落盘都在服务层做，这里就只剩「与用户交互」
/// 一件事。这样服务层在写盘之前还有机会再拦一次，不至于把超大内容直接写到磁盘上。
///
/// `suggested_file_name` 只用于预填对话框（文件名与文件类型过滤器），最终路径一律以
/// 用户点击「保存」后 Shell 返回的结果为准。
#[cfg(target_os = "windows")]
pub(crate) fn choose_save_path(
    owner: SaveDialogOwner,
    suggested_file_name: &str,
) -> Result<Option<String>, String> {
    use crate::infrastructure::windows::common::com;
    use crate::infrastructure::windows::common::wide::null_terminated;
    use windows::core::PCWSTR;
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
    use windows::Win32::System::Ole::OleInitialize;
    use windows::Win32::UI::Shell::{
        Common::COMDLG_FILTERSPEC, FileSaveDialog, IFileSaveDialog, FOS_FORCEFILESYSTEM,
        FOS_OVERWRITEPROMPT, FOS_PATHMUSTEXIST, SIGDN_FILESYSPATH,
    };

    // 这几个宽字符缓冲区必须先全部落定再取指针：对话框只持有指针，缓冲区提前析构就会
    // 变成野指针。
    let file_name_wide = null_terminated(suggested_file_name);
    let extension = extension_of(suggested_file_name);
    let filter_label_wide = null_terminated(&extension_filter_label(&extension));
    let filter_pattern_wide = null_terminated(&extension_filter_pattern(&extension));
    let default_extension_wide = null_terminated(&extension);

    unsafe {
        let _ = OleInitialize(None);
        let dialog: IFileSaveDialog = CoCreateInstance(&FileSaveDialog, None, CLSCTX_INPROC_SERVER)
            .map_err(|error| format!("无法创建保存对话框：{error}"))?;

        // 三个选项各自解决一个具体问题，都不该由宿主自己实现一遍：
        // FOS_FORCEFILESYSTEM 保证返回的是文件系统路径而不是「此电脑」这类虚拟项；
        // FOS_PATHMUSTEXIST 让用户只能落在真实存在的目录上；
        // FOS_OVERWRITEPROMPT 把重名覆盖确认交给系统。
        dialog
            .SetOptions(FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_OVERWRITEPROMPT)
            .map_err(|error| format!("无法设置保存对话框选项：{error}"))?;
        dialog
            .SetFileTypes(&[COMDLG_FILTERSPEC {
                pszName: PCWSTR(filter_label_wide.as_ptr()),
                pszSpec: PCWSTR(filter_pattern_wide.as_ptr()),
            }])
            .map_err(|error| format!("无法设置保存对话框文件类型：{error}"))?;
        dialog
            .SetFileName(PCWSTR(file_name_wide.as_ptr()))
            .map_err(|error| format!("无法设置保存对话框默认文件名：{error}"))?;
        // 扩展名为空时传的是单个结尾零，等价于「不设默认扩展名」。
        dialog
            .SetDefaultExtension(PCWSTR(default_extension_wide.as_ptr()))
            .map_err(|error| format!("无法设置保存对话框默认扩展名：{error}"))?;

        if let Err(error) = dialog.Show(Some(owner)) {
            if error.code().0 == HRESULT_ERROR_CANCELLED {
                return Ok(None);
            }

            return Err(format!("无法打开保存对话框：{error}"));
        }

        let item = dialog
            .GetResult()
            .map_err(|error| format!("无法读取选择的保存路径：{error}"))?;
        let path = item
            .GetDisplayName(SIGDN_FILESYSPATH)
            .map_err(|error| format!("无法解析选择的保存路径：{error}"))?;
        let path_text = com::take_pwstr_string(path)
            .map_err(|error| format!("无法转换选择的保存路径：{error}"))?;

        Ok(Some(path_text))
    }
}

/// 取建议文件名的扩展名（小写、不含点）；没有扩展名时返回空串。
///
/// 扩展名同时决定了对话框里的类型过滤器与默认扩展名，是这里唯一需要从文件名里解析的东西。
#[cfg(target_os = "windows")]
fn extension_of(file_name: &str) -> String {
    Path::new(file_name)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

/// 类型过滤器的显示名；没有扩展名时退化成「所有文件」。
#[cfg(target_os = "windows")]
fn extension_filter_label(extension: &str) -> String {
    if extension.is_empty() {
        return "所有文件".to_string();
    }

    format!("{} 文件", extension.to_ascii_uppercase())
}

/// 类型过滤器的匹配模式；没有扩展名时退化成「*.*」。
#[cfg(target_os = "windows")]
fn extension_filter_pattern(extension: &str) -> String {
    if extension.is_empty() {
        return "*.*".to_string();
    }

    format!("*.{extension}")
}

/// 非 Windows 平台没有当前产品目标里的原生保存对话框语义，保持显式错误避免误判已支持。
#[cfg(not(target_os = "windows"))]
pub(crate) fn choose_save_path(
    _owner: SaveDialogOwner,
    _suggested_file_name: &str,
) -> Result<Option<String>, String> {
    Err("当前平台暂不支持保存文件".to_string())
}
