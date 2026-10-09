/*
 * 两个页面共用的一份状态读写。
 *
 * 引入方式是普通的相对路径（`./state.js`），和页面里的相对链接一个道理：整个插件包挂在
 * 协议根的 `/<插件id>/` 下，包内引用必须写相对的——写成 `/state.js` 会落到协议根，
 * 指向别的插件去不了的地方。
 *
 * 这里落盘用的是 `dasktop.fs`，写进去的是**插件自己包目录内**的文件。浏览器侧没有
 * 文件系统，插件想留住什么只能走这条路径，宿主会把它限制在插件包目录内。
 */

export const STATE_FILE = "state.json";
export const HISTORY_LIMIT = 12;

export async function readState() {
  try {
    const parsed = JSON.parse(await dasktop.fs.read(STATE_FILE));

    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch {
    // 第一次运行时 state.json 还不存在，`fs.read` 会失败。这不是异常情况，
    // 所以不当错误上报——否则用户第一次打开就会看到一条吓人的红字。
    return { entries: [] };
  }
}

export async function writeState(state) {
  await dasktop.fs.write(STATE_FILE, JSON.stringify(state, null, 2));
}

export async function prependEntry(entry) {
  const state = await readState();

  state.entries = [{ at: new Date().toISOString(), ...entry }, ...state.entries].slice(
    0,
    HISTORY_LIMIT,
  );

  await writeState(state);
}
