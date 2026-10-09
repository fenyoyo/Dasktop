/**
 * Hello Dasktop —— 插件包框架的最小可用示例。
 *
 * 这份文件同时承担两个职责：
 * 1. 作为插件作者复制改造的起点，展示入口约定与权限用法；
 * 2. 被宿主以 `include_str!` 内嵌，首次运行时写入插件根目录，
 *    保证空环境下框架链路有可验证的样本。
 *
 * 约定要点：
 * - 必须是 ESM 模块，导出 `activate(host)`，可选导出 `deactivate()`；
 * - 不允许直接 import 任何 Tauri API，所有能力只能从 `host` 参数获取；
 * - `host` 上只存在清单已声明权限对应的方法，未声明的成员为 `undefined`，
 *   因此调用前必须做能力判定，而不是假定方法一定存在。
 */

/** 插件状态文件名，相对插件包目录解析，只能落在包内。 */
const STATE_FILE = "state.json";

/** 状态文件的兜底结构：文件不存在或内容损坏时都从零开始计数。 */
function createEmptyState() {
  return { activateCount: 0, lastActivatedAt: null };
}

/**
 * 读取上一次激活留下的状态。
 *
 * 状态文件属于插件自有数据，首次运行时并不存在；这里把「不存在」和「内容损坏」
 * 都归一成空状态，避免示例插件因为一次手改文件就永久无法激活。
 */
async function readState(host) {
  try {
    const raw = await host.fs.read(STATE_FILE);
    const parsed = JSON.parse(raw);
    return typeof parsed.activateCount === "number" ? parsed : createEmptyState();
  } catch {
    return createEmptyState();
  }
}

/**
 * 宿主加载插件时调用。
 *
 * @param {object} host 受控 API 上下文，只包含清单已声明的能力。
 */
export async function activate(host) {
  // fs 与 notify 都是按权限裁剪的：示例插件声明了全部四项权限，但这段代码
  // 仍然逐个判定，方便插件作者照抄后自行删减 permissions 时不会直接报错。
  if (host.log) {
    await host.log.write(`已激活，宿主版本 ${host.hostVersion}`);
  }

  if (!host.fs || !host.fs.read || !host.fs.write) {
    return;
  }

  const state = await readState(host);
  state.activateCount += 1;
  state.lastActivatedAt = new Date().toISOString();

  await host.fs.write(STATE_FILE, JSON.stringify(state, null, 2));

  if (host.notify) {
    await host.notify("Hello Dasktop", `示例插件第 ${state.activateCount} 次激活`);
  }
}

/**
 * 宿主卸载插件时调用；示例插件没有后台任务，只做一次收尾日志。
 */
export async function deactivate(host) {
  if (host && host.log) {
    await host.log.write("已卸载");
  }
}
