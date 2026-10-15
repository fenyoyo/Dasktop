//! 工作区窗口能力模块入口，对外只暴露捕获、定位、启动、命令执行和快捷方式操作。

pub(crate) mod shell_command;
pub(crate) mod window_capture;

pub(crate) use shell_command::run_shell_command;
pub(crate) use window_capture::{
    apply_window_placements, capture_visible_windows, create_workspace_shortcut,
    has_visible_window, launch_executable, WorkspaceWindow,
};
