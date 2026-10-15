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

/// 合并标准输出与标准错误，截取末尾片段并去除首尾空白。
///
/// cmd.exe 按系统代码页输出，非 ASCII 字符可能无法解码，
/// 这里用 lossy 转换保证不会因为编码问题丢掉整条结果。
fn combine_output(stdout: &[u8], stderr: &[u8]) -> String {
    let stdout_text = String::from_utf8_lossy(stdout).trim().to_owned();
    let stderr_text = String::from_utf8_lossy(stderr).trim().to_owned();

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
