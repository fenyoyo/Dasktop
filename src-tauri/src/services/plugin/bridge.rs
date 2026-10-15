//! 注入到插件页面的能力桥脚本。
//!
//! 脚本真身在同目录的 `bridge.js`，编译期由 `include_str!` 内嵌。这里只做一件事：
//! 把「这个插件是谁、声明了哪些能力」序列化后拼在脚本前面，让脚本自己读。
//!
//! 为什么不像示例插件那样放到 `plugins/` 下：那不是插件，是宿主的一部分，将来插件改成
//! 从远端仓库下载时它依然要跟着宿主走，不该出现在用户可编辑的插件目录里。
//!
//! 为什么用「拼一段配置 + 固定脚本」而不是模板替换：模板替换要求脚本里留一个占位符，
//! 而插件作者完全可能读到脚本源码、把占位符当成可改的变量。配置作为独立一行，语义清楚。

use serde::Serialize;

use crate::domain::plugin::PluginManifest;

/// 注入的桥配置。
///
/// 字段名用 camelCase，与脚本侧读取的名字逐字对应；脚本拿不到别的信息来源，
/// 名字写错只会表现成「能力全都不可用」，所以这里刻意保持极少的字段。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeConfig<'a> {
    /// 插件 id。脚本把它填进每次调用的参数里，作为宿主侧一致性的兜底——
    /// 真正生效的身份仍以调用方窗口标签为准（见 `services::plugin::resolve_caller_plugin_id`）。
    id: &'a str,
    /// 插件展示名，供页面自报家门。
    name: &'a str,
    /// 插件版本号。
    version: &'a str,
    /// 插件声明且宿主认识的能力权限。
    permissions: &'a [String],
}

/// 内嵌的能力桥脚本源码。
const BRIDGE_SOURCE: &str = include_str!("bridge.js");

/// 生成注入用的完整脚本。
///
/// 调用方必须已经确认清单里没有宿主不认识的权限——脚本按声明的权限挂载能力，
/// 一个拼错的权限只会让对应能力静默不出现，所以那道校验不能省。
pub fn build_script(plugin_id: &str, manifest: &PluginManifest) -> Result<String, String> {
    let config = BridgeConfig {
        id: plugin_id,
        name: &manifest.name,
        version: &manifest.version,
        permissions: &manifest.permissions,
    };

    let json = serde_json::to_string(&config)
        .map_err(|error| format!("能力桥配置序列化失败：{error}"))?;

    Ok(format!(
        "window.__DASKTOP_BRIDGE__ = {json};\n{BRIDGE_SOURCE}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(permissions: &[&str]) -> PluginManifest {
        PluginManifest {
            id: "demo".to_string(),
            name: "演示插件".to_string(),
            version: "1.0.0".to_string(),
            entry: "index.html".to_string(),
            permissions: permissions.iter().map(|item| item.to_string()).collect(),
            // 测试用的清单不关心窗口尺寸；取值优先级由 window_preference 单独覆盖。
            window: None,
            hotkeys: vec![],
        }
    }

    #[test]
    fn config_line_precedes_bridge_source() {
        let script = build_script("demo", &manifest(&["net:request"])).expect("脚本应可生成");

        // 配置必须排在脚本之前：脚本是 IIFE，执行时就去找这个全局。
        let config_at = script.find("__DASKTOP_BRIDGE__").expect("应写入配置");
        let source_at = script.find("CAPABILITY_TABLE").expect("应包含桥源码");

        assert!(config_at < source_at, "配置行必须在桥脚本之前");
    }

    #[test]
    fn carries_plugin_identity_and_permissions() {
        let script =
            build_script("http-console", &manifest(&["net:request", "log:write"])).expect("应可生成");

        assert!(script.contains("\"id\":\"http-console\""));
        assert!(script.contains("\"name\":\"演示插件\""));
        assert!(script.contains("\"permissions\":[\"net:request\",\"log:write\"]"));
    }

    #[test]
    fn manifest_values_cannot_break_out_of_the_config_line() {
        // 插件名来自磁盘上的 plugin.json，是完全由作者控制的文本。它被拼进一段
        // JavaScript 里执行，因此必须走 JSON 序列化——手写字符串拼接会让一个引号
        // 就变成可执行的代码，而那段代码跑在宿主注入的上下文里。
        let mut hostile = manifest(&[]);
        hostile.name = "x\"; window.pwned = true; \"".to_string();

        let script = build_script("demo", &hostile).expect("应可生成");

        assert!(
            !script.contains("window.pwned = true; \""),
            "插件名里的引号必须被转义，不能逃出配置字符串"
        );
        assert!(script.contains("\\\""));
    }
}
