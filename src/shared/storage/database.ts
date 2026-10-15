import Database from "@tauri-apps/plugin-sql";
import type {
  AppSettings,
  BoxConflictPolicy,
  BoxDeletePolicy,
  BoxDropAction,
} from "@/entities/appSettings/types";
import type { DesktopBox, DesktopBoxTitlePosition } from "@/entities/desktopBox/types";
import {
  APP_SETTINGS_STORAGE,
  DEFAULT_APP_SETTINGS,
  THEME_MODES,
  APP_SETTING_KEYS,
  APP_SETTING_NUMBER_LIMITS,
  BOX_CONFLICT_POLICIES,
  BOX_DELETE_POLICIES,
  BOX_DROP_ACTIONS,
  DESKTOP_NAME_DISPLAY_MODES,
  sanitizeNumberAppSetting,
  type AppSettingNumberKey,
} from "@/entities/appSettings/defaults";
import { BOX_DEFAULT_STATE, BOX_TITLE_OPACITY } from "@/entities/desktopBox/layout";
import type { PluginWindowSize } from "@/entities/pluginPackage/types";
import type { Workspace, WorkspaceWindow } from "@/entities/workspace/types";

let databasePromise: Promise<Database> | null = null;
/**
 * 数值型设置键从统一范围配置派生，数据库读取时不再手写多处分支
 */
const numericSettingKeys = Object.keys(APP_SETTING_NUMBER_LIMITS) as AppSettingNumberKey[];
const DESKTOP_BOX_TITLE_POSITIONS = ["top", "bottom"] as const;

/**
 * Dasktop 自动接管过的系统桌面图标记录，用于恢复时区分用户原本隐藏和应用主动隐藏。
 */
export interface ShellIconVisibilityRecord {
  managedHidden: boolean;
  previousVisible: boolean;
  shellId: string;
}

/**
 * SQLite 连接复用可以避免窗口同步和拖动保存时反复打开数据库
 */
async function getDatabase(): Promise<Database> {
  if (!databasePromise) {
    databasePromise = Database.load(APP_SETTINGS_STORAGE.databaseUrl);
  }

  return databasePromise;
}

/**
 * 初始化文件夹型 Box 的表结构；旧映射表直接删除，不保留路径关联兼容分支
 */
export async function initializeStorage(): Promise<void> {
  const database = await getDatabase();

  await database.execute("DROP TABLE IF EXISTS box_items");
  await resetIncompatibleBoxesTable(database);

  await database.execute(`
    CREATE TABLE IF NOT EXISTS ${APP_SETTINGS_STORAGE.tables.boxes} (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      folder_path TEXT NOT NULL,
      collapsed INTEGER NOT NULL DEFAULT 0,
      locked INTEGER NOT NULL DEFAULT 0,
      title_opacity INTEGER NOT NULL DEFAULT 100,
      title_position TEXT NOT NULL DEFAULT 'top',
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  await database.execute(`
    CREATE TABLE IF NOT EXISTS ${APP_SETTINGS_STORAGE.tables.appSettings} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  await ensureBoxItemOrderStorage(database);
  await ensureBoxVirtualItemStorage(database);
  await ensureShellIconVisibilityRecordStorage(database);
  await ensurePluginWindowSizeStorage(database);
  await ensurePluginHotkeyStorage(database);
  await ensureWorkspaceStorage(database);
}

/**
 * 插件窗口尺寸表由宿主与设置页共同读写：宿主在插件窗口关闭时写回最后一次尺寸
 * （见 Rust `services/plugin/window_preference.rs`），设置页负责展示与重置。
 *
 * 表结构必须与 Rust 侧的 `ensure_window_size_storage` 保持一致。
 */
async function ensurePluginWindowSizeStorage(database: Database): Promise<void> {
  await database.execute(`
    CREATE TABLE IF NOT EXISTS ${APP_SETTINGS_STORAGE.tables.pluginWindowSizes} (
      plugin_id TEXT PRIMARY KEY,
      width REAL NOT NULL,
      height REAL NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

/**
 * 宿主启动热键配置表由宿主与设置页共同读写：宿主注册层在设置窗尚未连库时也可能需要读配置。
 *
 * 表结构必须与 Rust 侧 `services/plugin/hotkey.rs` 的 `ensure_storage` 保持一致——每插件一行，
 * 主键即 `plugin_id`。
 */
async function ensurePluginHotkeyStorage(database: Database): Promise<void> {
  await database.execute(`
    CREATE TABLE IF NOT EXISTS ${APP_SETTINGS_STORAGE.tables.pluginHotkeys} (
      plugin_id TEXT NOT NULL PRIMARY KEY,
      accelerator TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    )
  `);
}

/**
 * Box 文件顺序可能在快照启动的独立 Box 窗口中读写，因此表结构创建不能只依赖主窗口初始化。
 */
async function ensureBoxItemOrderStorage(database: Database): Promise<void> {
  await database.execute(`
    CREATE TABLE IF NOT EXISTS ${APP_SETTINGS_STORAGE.tables.boxItemOrders} (
      box_id TEXT NOT NULL,
      item_path TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (box_id, item_path)
    )
  `);
}

/**
 * Shell 虚拟项没有真实文件路径，单独保存引用，避免删除或剪贴板逻辑误触真实文件操作。
 */
async function ensureBoxVirtualItemStorage(database: Database): Promise<void> {
  await database.execute(`
    CREATE TABLE IF NOT EXISTS ${APP_SETTINGS_STORAGE.tables.boxVirtualItems} (
      box_id TEXT NOT NULL,
      shell_id TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (box_id, shell_id)
    )
  `);
}

/**
 * 系统桌面图标隐藏状态必须单独记录接管前状态，避免移出 Box 时误显示用户原本隐藏的图标。
 */
async function ensureShellIconVisibilityRecordStorage(database: Database): Promise<void> {
  await database.execute(`
    CREATE TABLE IF NOT EXISTS ${APP_SETTINGS_STORAGE.tables.shellIconVisibilityRecords} (
      shell_id TEXT PRIMARY KEY,
      previous_visible INTEGER NOT NULL,
      managed_hidden INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

/**
 * 当前版本不迁移旧映射结构；缺少真实文件夹路径的旧 boxes 表会被整体重建为空状态
 */
async function resetIncompatibleBoxesTable(database: Database): Promise<void> {
  const rows = await database.select<Array<Record<string, unknown>>>(`
    PRAGMA table_info(${APP_SETTINGS_STORAGE.tables.boxes})
  `);
  if (rows.length === 0) {
    return;
  }

  const columnNames = new Set(rows.map((row) => String(row.name)));
  if (columnNames.has("folder_path")) {
    return;
  }

  await database.execute(`DROP TABLE IF EXISTS ${APP_SETTINGS_STORAGE.tables.boxes}`);
}

/**
 * 读取所有 Box 布局和真实文件夹路径；Box 内容由 Explorer 原生视图按 folderPath 展示
 */
export async function loadBoxes(): Promise<DesktopBox[]> {
  const database = await getDatabase();
  const rows = await database.select<Array<Record<string, unknown>>>(`
    SELECT id, title, folder_path, collapsed, locked, title_opacity, title_position, x, y, width, height
    FROM ${APP_SETTINGS_STORAGE.tables.boxes}
    ORDER BY updated_at ASC
  `);

  return rows.map((row) => ({
    collapsed: sanitizeDesktopBoxBoolean(row.collapsed),
    folderPath: String(row.folder_path),
    id: String(row.id),
    locked: sanitizeDesktopBoxBoolean(row.locked),
    title: String(row.title),
    titleOpacity: sanitizeDesktopBoxTitleOpacity(row.title_opacity),
    titlePosition: sanitizeDesktopBoxTitlePosition(row.title_position),
    x: Number(row.x),
    y: Number(row.y),
    width: Number(row.width),
    height: Number(row.height),
  }));
}

/**
 * 保存单个 Box 状态；真实文件移动由 Windows Explorer 或后端 Shell 命令处理，不写关联表
 */
export async function saveBox(box: DesktopBox): Promise<void> {
  const database = await getDatabase();

  await database.execute(
    `
      INSERT INTO ${APP_SETTINGS_STORAGE.tables.boxes} (id, title, folder_path, collapsed, locked, title_opacity, title_position, x, y, width, height, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        folder_path = excluded.folder_path,
        collapsed = excluded.collapsed,
        locked = excluded.locked,
        title_opacity = excluded.title_opacity,
        title_position = excluded.title_position,
        x = excluded.x,
        y = excluded.y,
        width = excluded.width,
        height = excluded.height,
        updated_at = excluded.updated_at
    `,
    [
      box.id,
      box.title,
      box.folderPath,
      box.collapsed ? 1 : 0,
      box.locked ? 1 : 0,
      sanitizeDesktopBoxTitleOpacity(box.titleOpacity),
      box.titlePosition,
      box.x,
      box.y,
      box.width,
      box.height,
      Date.now(),
    ],
  );
}

/**
 * 读取单个 Box 的手动文件顺序；真实文件是否仍存在由文件扫描层结合当前目录结果裁剪。
 */
export async function loadBoxItemOrder(boxId: string): Promise<string[]> {
  const database = await getDatabase();
  await ensureBoxItemOrderStorage(database);
  const rows = await database.select<Array<Record<string, unknown>>>(
    `
      SELECT item_path
      FROM ${APP_SETTINGS_STORAGE.tables.boxItemOrders}
      WHERE box_id = $1
      ORDER BY sort_order ASC, updated_at ASC
    `,
    [boxId],
  );

  return rows.map((row) => String(row.item_path));
}

/**
 * 读取 Box 内保存的 Shell 虚拟项 ID，后续由后端按当前系统环境重建展示模型。
 */
export async function loadBoxVirtualItemIds(boxId: string): Promise<string[]> {
  const database = await getDatabase();
  await ensureBoxVirtualItemStorage(database);
  const rows = await database.select<Array<Record<string, unknown>>>(
    `
      SELECT shell_id
      FROM ${APP_SETTINGS_STORAGE.tables.boxVirtualItems}
      WHERE box_id = $1
      ORDER BY sort_order ASC, updated_at ASC
    `,
    [boxId],
  );

  return rows.map((row) => String(row.shell_id));
}

/**
 * 读取所有 Box 内保存的 Shell 虚拟项 ID，用于按全局引用计数决定是否恢复原生桌面图标。
 */
export async function loadAllBoxVirtualItemIds(): Promise<string[]> {
  const database = await getDatabase();
  await ensureBoxVirtualItemStorage(database);
  const rows = await database.select<Array<Record<string, unknown>>>(`
    SELECT shell_id
    FROM ${APP_SETTINGS_STORAGE.tables.boxVirtualItems}
    ORDER BY updated_at ASC, sort_order ASC
  `);

  return rows.map((row) => String(row.shell_id));
}

/**
 * 保存当前 Box 的完整手动顺序；调用方已按最新扫描结果过滤路径，旧路径不做兼容保留。
 */
export async function saveBoxItemOrder(boxId: string, orderedPaths: string[]): Promise<void> {
  const database = await getDatabase();
  const updatedAt = Date.now();
  await ensureBoxItemOrderStorage(database);

  await database.execute(
    `DELETE FROM ${APP_SETTINGS_STORAGE.tables.boxItemOrders} WHERE box_id = $1`,
    [boxId],
  );

  for (const [index, itemPath] of orderedPaths.entries()) {
    await database.execute(
      `
        INSERT INTO ${APP_SETTINGS_STORAGE.tables.boxItemOrders} (box_id, item_path, sort_order, updated_at)
        VALUES ($1, $2, $3, $4)
      `,
      [boxId, itemPath, index, updatedAt],
    );
  }
}

/**
 * 保存 Box 内 Shell 虚拟项完整列表；调用方负责按最新 UI 顺序去重后传入。
 */
export async function saveBoxVirtualItemIds(boxId: string, shellIds: string[]): Promise<void> {
  const database = await getDatabase();
  const updatedAt = Date.now();
  const uniqueShellIds = dedupePreservingOrder(shellIds);
  await ensureBoxVirtualItemStorage(database);

  await database.execute(
    `DELETE FROM ${APP_SETTINGS_STORAGE.tables.boxVirtualItems} WHERE box_id = $1`,
    [boxId],
  );

  for (const [index, shellId] of uniqueShellIds.entries()) {
    await database.execute(
      `
        INSERT INTO ${APP_SETTINGS_STORAGE.tables.boxVirtualItems} (box_id, shell_id, sort_order, updated_at)
        VALUES ($1, $2, $3, $4)
      `,
      [boxId, shellId, index, updatedAt],
    );
  }
}

/**
 * 拖入系统桌面图标时只追加尚不存在的 Shell 引用，避免重复拖入产生多个相同入口。
 */
export async function appendBoxVirtualItemIds(boxId: string, shellIds: string[]): Promise<void> {
  if (shellIds.length === 0) {
    return;
  }

  const currentShellIds = await loadBoxVirtualItemIds(boxId);
  await saveBoxVirtualItemIds(boxId, [...currentShellIds, ...shellIds]);
}

/**
 * 删除 Box 内系统桌面图标只移除引用，不能调用回收站或真实路径删除。
 */
export async function removeBoxVirtualItemIds(
  boxId: string,
  shellIds: string[],
): Promise<void> {
  if (shellIds.length === 0) {
    return;
  }

  const removedShellIdSet = new Set(shellIds);
  const nextShellIds = (await loadBoxVirtualItemIds(boxId)).filter(
    (shellId) => !removedShellIdSet.has(shellId),
  );
  await saveBoxVirtualItemIds(boxId, nextShellIds);
}

/**
 * 读取 Dasktop 管理过的系统桌面图标隐藏记录，供启动同步和关闭总开关时恢复状态。
 */
export async function loadShellIconVisibilityRecords(): Promise<ShellIconVisibilityRecord[]> {
  const database = await getDatabase();
  await ensureShellIconVisibilityRecordStorage(database);
  const rows = await database.select<Array<Record<string, unknown>>>(`
    SELECT shell_id, previous_visible, managed_hidden
    FROM ${APP_SETTINGS_STORAGE.tables.shellIconVisibilityRecords}
    ORDER BY updated_at ASC
  `);

  return rows.map((row) => ({
    managedHidden: sanitizeStoredBoolean(row.managed_hidden),
    previousVisible: sanitizeStoredBoolean(row.previous_visible),
    shellId: String(row.shell_id),
  }));
}

/**
 * 保存单个系统图标的接管记录；重复接管时只更新当前管理态，不覆盖首次接管前状态。
 */
export async function saveShellIconVisibilityRecord(
  record: ShellIconVisibilityRecord,
): Promise<void> {
  const database = await getDatabase();
  await ensureShellIconVisibilityRecordStorage(database);
  await database.execute(
    `
      INSERT INTO ${APP_SETTINGS_STORAGE.tables.shellIconVisibilityRecords} (shell_id, previous_visible, managed_hidden, updated_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT(shell_id) DO UPDATE SET
        previous_visible = ${APP_SETTINGS_STORAGE.tables.shellIconVisibilityRecords}.previous_visible,
        managed_hidden = excluded.managed_hidden,
        updated_at = excluded.updated_at
    `,
    [
      record.shellId,
      record.previousVisible ? 1 : 0,
      record.managedHidden ? 1 : 0,
      Date.now(),
    ],
  );
}

/**
 * 原生图标已经按规则恢复或总开关关闭后，清理 Dasktop 的接管痕迹。
 */
export async function deleteShellIconVisibilityRecord(shellId: string): Promise<void> {
  const database = await getDatabase();
  await ensureShellIconVisibilityRecordStorage(database);
  await database.execute(
    `DELETE FROM ${APP_SETTINGS_STORAGE.tables.shellIconVisibilityRecords} WHERE shell_id = $1`,
    [shellId],
  );
}

/**
 * 删除 Box 记录只影响 Dasktop 窗口状态；真实文件夹处理必须先由调用方完成并确认成功
 */
export async function deleteBoxRecord(boxId: string): Promise<void> {
  const database = await getDatabase();
  await ensureBoxItemOrderStorage(database);
  await ensureBoxVirtualItemStorage(database);

  await database.execute(
    `DELETE FROM ${APP_SETTINGS_STORAGE.tables.boxItemOrders} WHERE box_id = $1`,
    [boxId],
  );
  await database.execute(
    `DELETE FROM ${APP_SETTINGS_STORAGE.tables.boxVirtualItems} WHERE box_id = $1`,
    [boxId],
  );
  await database.execute(`DELETE FROM ${APP_SETTINGS_STORAGE.tables.boxes} WHERE id = $1`, [boxId]);
}

/**
 * 按出现顺序去重，保证拖入和排序结果稳定，不受 Set 序列化细节影响。
 */
function dedupePreservingOrder(values: string[]): string[] {
  const seenValues = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    if (seenValues.has(value)) {
      continue;
    }

    seenValues.add(value);
    result.push(value);
  }

  return result;
}

/**
 * 工作区表保存用户命名的应用窗口布局，窗口列表与附加命令都以 JSON 存储。
 *
 * 窗口数量和字段结构随捕获结果变化，拆成子表只会增加同步成本，
 * 且工作区始终整体读写，因此用单个 JSON 列承载窗口列表；
 * 附加命令是同样性质的变长列表，一并按 JSON 列存储。
 */
async function ensureWorkspaceStorage(database: Database): Promise<void> {
  await resetIncompatibleWorkspacesTable(database);

  await database.execute(`
    CREATE TABLE IF NOT EXISTS ${APP_SETTINGS_STORAGE.tables.workspaces} (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      windows_json TEXT NOT NULL,
      launch_interval_seconds INTEGER NOT NULL DEFAULT 0,
      commands_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    )
  `);
}

/**
 * 当前版本不迁移旧工作区结构；缺少新列的旧表会被整体重建为空状态。
 *
 * 与 boxes 表保持同一策略：未上线前不做数据结构迁移，
 * 避免为了兼容旧列在读写路径上留下分支判断。
 */
async function resetIncompatibleWorkspacesTable(database: Database): Promise<void> {
  const rows = await database.select<Array<Record<string, unknown>>>(`
    PRAGMA table_info(${APP_SETTINGS_STORAGE.tables.workspaces})
  `);
  if (rows.length === 0) {
    return;
  }

  const columnNames = new Set(rows.map((row) => String(row.name)));
  if (columnNames.has("launch_interval_seconds") && columnNames.has("commands_json")) {
    return;
  }

  await database.execute(`DROP TABLE IF EXISTS ${APP_SETTINGS_STORAGE.tables.workspaces}`);
}

/**
 * 读取全部工作区，按创建时间升序返回，保证列表顺序稳定。
 */
export async function loadWorkspaces(): Promise<Workspace[]> {
  const database = await getDatabase();
  await ensureWorkspaceStorage(database);
  const rows = await database.select<Array<Record<string, unknown>>>(`
    SELECT id, name, windows_json, launch_interval_seconds, commands_json, created_at
    FROM ${APP_SETTINGS_STORAGE.tables.workspaces}
    ORDER BY created_at ASC
  `);

  return rows.map((row) => ({
    commands: parseWorkspaceCommands(row.commands_json),
    createdAt: Number(row.created_at),
    id: String(row.id),
    launchIntervalSeconds: sanitizeWorkspaceLaunchInterval(row.launch_interval_seconds),
    name: String(row.name),
    windows: parseWorkspaceWindows(row.windows_json),
  }));
}

/**
 * 保存单个工作区，同名冲突时整体覆盖。
 */
export async function saveWorkspace(workspace: Workspace): Promise<void> {
  const database = await getDatabase();
  await ensureWorkspaceStorage(database);

  await database.execute(
    `
      INSERT INTO ${APP_SETTINGS_STORAGE.tables.workspaces} (id, name, windows_json, launch_interval_seconds, commands_json, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        windows_json = excluded.windows_json,
        launch_interval_seconds = excluded.launch_interval_seconds,
        commands_json = excluded.commands_json,
        created_at = excluded.created_at
    `,
    [
      workspace.id,
      workspace.name,
      JSON.stringify(workspace.windows),
      sanitizeWorkspaceLaunchInterval(workspace.launchIntervalSeconds),
      JSON.stringify(sanitizeWorkspaceCommands(workspace.commands)),
      workspace.createdAt,
    ],
  );
}

/**
 * 删除单个工作区。
 */
export async function deleteWorkspaceRecord(workspaceId: string): Promise<void> {
  const database = await getDatabase();
  await ensureWorkspaceStorage(database);
  await database.execute(`DELETE FROM ${APP_SETTINGS_STORAGE.tables.workspaces} WHERE id = $1`, [
    workspaceId,
  ]);
}

/**
 * 反序列化工作区窗口列表，脏数据直接丢弃而不是让整个工作区读取失败。
 */
function parseWorkspaceWindows(raw: unknown): WorkspaceWindow[] {
  try {
    const parsed = JSON.parse(String(raw));
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(isWorkspaceWindow).map(normalizeWorkspaceWindow);
  } catch {
    return [];
  }
}

/**
 * 启动间隔的取值范围，单位为秒。
 *
 * 上限取 60 秒：再长会把一次还原拖成几分钟，用户等待成本明显高于错峰收益；
 * 下限为 0，表示关闭间隔、连续启动。
 */
const WORKSPACE_LAUNCH_INTERVAL_RANGE = { max: 60, min: 0 } as const;

/**
 * 单条附加命令的长度上限。
 *
 * 命令交给 cmd 执行，异常超长的文本既没有意义也会拖慢结果展示，
 * 因此在写入前直接截断。
 */
const WORKSPACE_COMMAND_MAX_LENGTH = 512;

/**
 * 规范化附加命令列表：只保留非空字符串，去首尾空白并截断超长文本。
 *
 * 读写两侧都经过这里：界面允许用户先敲一条空行再补内容，
 * 库里也可能被外部改动成其它结构，脏数据直接过滤而不是让还原流程带上
 * 一条无法执行的空命令。
 */
export function sanitizeWorkspaceCommands(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, WORKSPACE_COMMAND_MAX_LENGTH))
    .filter((item) => item.length > 0);
}

/**
 * 反序列化附加命令列表，JSON 损坏时退化为空列表。
 */
function parseWorkspaceCommands(raw: unknown): string[] {
  try {
    return sanitizeWorkspaceCommands(JSON.parse(String(raw)));
  } catch {
    return [];
  }
}

/**
 * 把启动间隔规范成合法整数秒。
 *
 * 输入框允许自由文本、数据库列也可能被外部改动，因此读取和写入都经过这里：
 * 非法值按 0 处理，越界值夹到边界，而不是丢弃整条工作区记录。
 */
export function sanitizeWorkspaceLaunchInterval(value: unknown): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) {
    return WORKSPACE_LAUNCH_INTERVAL_RANGE.min;
  }

  return Math.min(
    WORKSPACE_LAUNCH_INTERVAL_RANGE.max,
    Math.max(WORKSPACE_LAUNCH_INTERVAL_RANGE.min, Math.trunc(seconds)),
  );
}

/**
 * 补齐窗口条目中在旧版本里不存在的可选字段。
 *
 * `arguments` 与 `minimized` 都是后加的字段，旧记录里没有它们；
 * Rust 侧这两项是必填的 bool 与 String，直接发送 undefined 会触发反序列化失败，
 * 因此读取时统一补齐默认值。
 */
function normalizeWorkspaceWindow(window: WorkspaceWindow): WorkspaceWindow {
  return {
    ...window,
    arguments: typeof window.arguments === "string" ? window.arguments : "",
    minimized: window.minimized === true,
  };
}

/**
 * 校验窗口条目结构，避免损坏的 JSON 内容进入还原流程触发系统调用。
 *
 * 只校验必填的位置与路径字段；`arguments` 与 `minimized` 属于后加的
 * 可选字段，由 `normalizeWorkspaceWindow` 在之后补齐默认值。
 */
function isWorkspaceWindow(value: unknown): value is WorkspaceWindow {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.executablePath === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.x === "number" &&
    typeof candidate.y === "number" &&
    typeof candidate.width === "number" &&
    typeof candidate.height === "number"
  );
}

/**
 * 读取当前设置，并过滤掉旧版本残留或非法的设置值
 */
export async function loadSettings(): Promise<AppSettings> {
  const database = await getDatabase();
  const rows = await database.select<Array<Record<string, unknown>>>(`
    SELECT key, value FROM ${APP_SETTINGS_STORAGE.tables.appSettings}
  `);
  const settings = { ...DEFAULT_APP_SETTINGS };
  const supportedKeys = new Set<keyof AppSettings>(Object.values(APP_SETTING_KEYS));

  for (const row of rows) {
    const key = String(row.key) as keyof AppSettings;
    if (supportedKeys.has(key)) {
      const value = JSON.parse(String(row.value));
      settings[key] = sanitizeSettingValue(key, value) as never;
    }
  }

  return settings;
}

/**
 * 设置读取只接受当前版本定义的值，旧版字段不会被迁移回新状态
 */
function sanitizeSettingValue<Key extends keyof AppSettings>(
  key: Key,
  value: unknown,
): AppSettings[Key] {
  if (key === APP_SETTING_KEYS.settingsTheme || key === APP_SETTING_KEYS.boxTheme) {
    return (isThemeMode(value) ? value : DEFAULT_APP_SETTINGS[key]) as AppSettings[Key];
  }

  if (
    key === APP_SETTING_KEYS.snapToEdges ||
    key === APP_SETTING_KEYS.boxResizeGridEnabled ||
    key === APP_SETTING_KEYS.showItemLabels ||
    key === APP_SETTING_KEYS.showShortcutArrow ||
    key === APP_SETTING_KEYS.autoHideNativeShellIcons ||
    key === APP_SETTING_KEYS.doubleClickOpenItems
  ) {
    return (typeof value === "boolean" ? value : DEFAULT_APP_SETTINGS[key]) as AppSettings[Key];
  }

  if (key === APP_SETTING_KEYS.collectionRootPath) {
    return (typeof value === "string" ? value : DEFAULT_APP_SETTINGS[key]) as AppSettings[Key];
  }

  if (key === APP_SETTING_KEYS.boxDeletePolicy) {
    return (isBoxDeletePolicy(value)
      ? value
      : DEFAULT_APP_SETTINGS.boxDeletePolicy) as AppSettings[Key];
  }

  if (key === APP_SETTING_KEYS.boxConflictPolicy) {
    return (isBoxConflictPolicy(value)
      ? value
      : DEFAULT_APP_SETTINGS.boxConflictPolicy) as AppSettings[Key];
  }

  if (key === APP_SETTING_KEYS.boxDropAction || key === APP_SETTING_KEYS.boxDragOutAction) {
    return (isBoxDropAction(value)
      ? value
      : DEFAULT_APP_SETTINGS[key]) as AppSettings[Key];
  }

  if (key === APP_SETTING_KEYS.nameDisplayMode) {
    return (isDesktopNameDisplayMode(value)
      ? value
      : DEFAULT_APP_SETTINGS.nameDisplayMode) as AppSettings[Key];
  }

  if (isNumericSettingKey(key)) {
    return sanitizeNumberAppSetting(key, value) as AppSettings[Key];
  }

  return DEFAULT_APP_SETTINGS[key];
}

/**
 * 类型守卫把普通设置键收窄到数值设置键，便于复用统一的范围校验函数
 */
function isNumericSettingKey(key: keyof AppSettings): key is AppSettingNumberKey {
  return numericSettingKeys.some((settingKey) => settingKey === key);
}

/**
 * 主题枚举只允许当前三种值，避免历史状态继续污染 UI
 */
function isThemeMode(value: unknown): value is AppSettings["settingsTheme"] {
  return THEME_MODES.some((themeMode) => themeMode === value);
}

/**
 * 删除策略只接受当前设置页提供的三种值，避免误把旧字符串传入真实文件操作
 */
function isBoxDeletePolicy(value: unknown): value is BoxDeletePolicy {
  return BOX_DELETE_POLICIES.some((policy) => policy === value);
}

/**
 * 同名策略只接受当前设置页提供的三种值，避免替换类真实文件操作被脏值触发
 */
function isBoxConflictPolicy(value: unknown): value is BoxConflictPolicy {
  return BOX_CONFLICT_POLICIES.some((policy) => policy === value);
}

/**
 * 拖入策略只接受当前设置页提供的三种值，避免未知字符串触发真实文件操作
 */
function isBoxDropAction(value: unknown): value is BoxDropAction {
  return BOX_DROP_ACTIONS.some((action) => action === value);
}

/**
 * 文件名显示模式只接受设置页暴露的三种值，避免标签格式化读到未知策略。
 */
function isDesktopNameDisplayMode(value: unknown): value is AppSettings["nameDisplayMode"] {
  return DESKTOP_NAME_DISPLAY_MODES.some((mode) => mode === value);
}

/**
 * SQLite 中布尔值统一以 0/1 保存，读取时保持严格归一，避免字符串脏值影响恢复逻辑。
 */
function sanitizeStoredBoolean(value: unknown): boolean {
  return Number(value) === 1;
}

/**
 * Box 标题位置只接受当前菜单提供的上下两种布局
 */
function isDesktopBoxTitlePosition(value: unknown): value is DesktopBoxTitlePosition {
  return DESKTOP_BOX_TITLE_POSITIONS.some((position) => position === value);
}

/**
 * SQLite 布尔值以 0/1 保存，读取时只接受明确开启状态，避免脏值误锁定窗口
 */
function sanitizeDesktopBoxBoolean(value: unknown): boolean {
  return value === 1 || value === "1" || value === true;
}

/**
 * Box 标题位置保存在布局表中，非法值回退到默认上方，避免窗口渲染出现无序 order
 */
function sanitizeDesktopBoxTitlePosition(value: unknown): DesktopBoxTitlePosition {
  return isDesktopBoxTitlePosition(value) ? value : BOX_DEFAULT_STATE.titlePosition;
}

/**
 * 闲置可见度只允许 0-100 的百分比，防止菜单滑块和渲染样式出现不同步
 */
function sanitizeDesktopBoxTitleOpacity(value: unknown): number {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return BOX_DEFAULT_STATE.titleOpacity;
  }

  return Math.round(
    Math.min(Math.max(numericValue, BOX_TITLE_OPACITY.min), BOX_TITLE_OPACITY.max),
  );
}

/**
 * 写入单个插件的窗口尺寸，已存在时覆盖。
 *
 * 这里不做夹取：读取方（宿主 `services/plugin/window_preference.rs`）在取用时统一收敛，
 * 前端再加一道夹取就等于把边界规则复制到第二处，而面板显示的值也来自宿主，
 * 本地夹取只会让两处结果出现无人察觉的分叉。
 */
export async function savePluginWindowSize(
  pluginId: string,
  size: PluginWindowSize,
): Promise<void> {
  const database = await getDatabase();

  await database.execute(
    `
      INSERT INTO ${APP_SETTINGS_STORAGE.tables.pluginWindowSizes}
        (plugin_id, width, height, updated_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT(plugin_id) DO UPDATE SET
        width = excluded.width,
        height = excluded.height,
        updated_at = excluded.updated_at
    `,
    [pluginId, size.width, size.height, Date.now()],
  );
}

/**
 * 删除单个插件记住的窗口尺寸，让它回到清单声明或全局默认值。
 */
export async function deletePluginWindowSize(pluginId: string): Promise<void> {
  const database = await getDatabase();

  await database.execute(
    `DELETE FROM ${APP_SETTINGS_STORAGE.tables.pluginWindowSizes} WHERE plugin_id = $1`,
    [pluginId],
  );
}

/**
 * 按键保存设置，保持设置项独立更新，避免整行 JSON 合并冲突
 */
export async function saveSetting<Key extends keyof AppSettings>(
  key: Key,
  value: AppSettings[Key],
): Promise<void> {
  const database = await getDatabase();

  await database.execute(
    `
      INSERT INTO ${APP_SETTINGS_STORAGE.tables.appSettings} (key, value, updated_at)
      VALUES ($1, $2, $3)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `,
    [key, JSON.stringify(value), Date.now()],
  );
}
