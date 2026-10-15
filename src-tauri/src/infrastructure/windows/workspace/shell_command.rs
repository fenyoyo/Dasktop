//! 工作区附加命令的执行能力。
//!
//! 用户在界面上填写的是 shell 片段（例如 `docker start mysql`），
//! 需要 shell 解释 PATH 解析、`&&` 串联和重定向，因此统一交给系统的
//! cmd.exe 以 `/C` 执行，而不是直接 CreateProcess 去解析命令行。

/// 回显进结果消息的输出长度上限。
///
/// 失败时用于给出可读线索，但完整输出可能很长（例如镜像拉取日志），
/// 直接塞进弹窗会把界面撑爆，因此只保留末尾片段。
const COMMAND_OUTPUT_LIMIT: usize = 200;

/// 执行一条附加命令，返回输出摘要。
///
/// 返回 `Ok` 表示命令以 0 退出，内容为合并后的标准输出与标准错误（可能为空）；
/// 返回 `Err` 表示无法启动或退出码非 0，内容为带退出码的失败原因。
///
/// 以不创建控制台窗口的方式启动：Dasktop 是 GUI 程序，
/// 直接拉起 cmd 会在用户桌面上闪出一个黑框。
#[cfg(target_os = "windows")]
pub(crate) fn run_shell_command(command: &str) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    /// CREATE_NO_WINDOW：禁止为子进程分配控制台窗口，避免黑框闪烁。
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let output = Command::new("cmd")
        .arg("/C")
        .arg(command)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|error| format!("无法启动命令: {error}"))?;

    let combined = combine_output(&output.stdout, &output.stderr);

    if output.status.success() {
        return Ok(combined);
    }

    let exit_code = output
        .status
        .code()
        .map_or_else(|| "未知".to_owned(), |code| code.to_string());

    Err(format!("命令退出码 {exit_code}: {combined}"))
}

/// 非 Windows 平台不提供命令执行能力。
#[cfg(not(target_os = "windows"))]
pub(crate) fn run_shell_command(_command: &str) -> Result<String, String> {
    Err("工作区仅支持 Windows 平台".to_owned())
}

/// 解码子进程输出。
///
/// 分两档尝试，因为同一条命令的两个来源写出的编码并不一致：
/// - 现代 CLI（docker、git 等）直接按 UTF-8 写管道，严格 UTF-8 解码即可命中；
/// - cmd 自身及系统内置工具（ping、ipconfig 等）按控制台代码页写字节，
///   简体中文 Windows 下是 936（GBK），若按 UTF-8 解会整段变成乱码，
///   因此校验失败时退回系统 OEM 代码页解码。
fn decode_output(bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_owned();
    }

    #[cfg(target_os = "windows")]
    {
        windows_impl::decode_with_oem_code_page(bytes)
    }

    #[cfg(not(target_os = "windows"))]
    {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

/// Windows 平台专属实现：把按系统代码页写出的字节转换为字符串。
#[cfg(target_os = "windows")]
mod windows_impl {
    use windows::Win32::Globalization::{
        MultiByteToWideChar, CP_OEMCP, MULTI_BYTE_TO_WIDE_CHAR_FLAGS,
    };

    /// 按系统 OEM 代码页解码字节。
    ///
    /// 简体中文 Windows 的 OEM 代码页是 936，与 cmd 默认控制台的输出代码页一致。
    /// 非法字节会被替换为 U+FFFD 而不是整体失败，因此不需要额外错误分支，
    /// 只有连一次转换都做不成时才退回到 lossy 解码兜底。
    pub(super) fn decode_with_oem_code_page(bytes: &[u8]) -> String {
        if bytes.is_empty() {
            return String::new();
        }

        // 先只探测目标缓冲需要的宽字符数量：此时不传输出缓冲，返回 0 表示无法解码。
        let required_length =
            unsafe { MultiByteToWideChar(CP_OEMCP, MULTI_BYTE_TO_WIDE_CHAR_FLAGS(0), bytes, None) };
        if required_length <= 0 {
            return String::from_utf8_lossy(bytes).into_owned();
        }

        let mut buffer = vec![0_u16; required_length as usize];
        let written_length = unsafe {
            MultiByteToWideChar(
                CP_OEMCP,
                MULTI_BYTE_TO_WIDE_CHAR_FLAGS(0),
                bytes,
                Some(&mut buffer),
            )
        };
        if written_length <= 0 {
            return String::from_utf8_lossy(bytes).into_owned();
        }

        String::from_utf16_lossy(&buffer[..written_length as usize])
    }
}

/// 合并标准输出与标准错误，截取末尾片段并去除首尾空白。
fn combine_output(stdout: &[u8], stderr: &[u8]) -> String {
    let stdout_text = decode_output(stdout).trim().to_owned();
    let stderr_text = decode_output(stderr).trim().to_owned();

    let combined = match (stdout_text.is_empty(), stderr_text.is_empty()) {
        (true, true) => String::new(),
        (false, true) => stdout_text,
        (true, false) => stderr_text,
        (false, false) => format!("{stdout_text}\n{stderr_text}"),
    };

    tail_of(&combined)
}

/// 超长时只保留末尾字符，失败线索通常出现在输出最后几行。
fn tail_of(text: &str) -> String {
    let character_count = text.chars().count();
    if character_count <= COMMAND_OUTPUT_LIMIT {
        return text.to_owned();
    }

    text.chars()
        .skip(character_count - COMMAND_OUTPUT_LIMIT)
        .collect()
}

/// 输出解码覆盖两类编码，判断错误会让中文提示直接变成乱码。
#[cfg(test)]
mod tests {
    use super::decode_output;

    /// 现代 CLI 的 UTF-8 输出必须原样保留，不能被代码页回退改写。
    #[test]
    fn keeps_utf8_output_intact() {
        assert_eq!(
            decode_output("container mysql started".as_bytes()),
            "container mysql started"
        );
    }

    /// cmd 内置工具的中文输出按 936 写字节，必须走代码页回退才能还原。
    #[test]
    fn decodes_oem_code_page_output() {
        // 「中文」的 GBK 编码，字节序列不是合法 UTF-8，会落到回退分支。
        let oem_bytes = [0xD6, 0xD0, 0xCE, 0xC4];

        assert_eq!(decode_output(&oem_bytes), "中文");
    }
}
