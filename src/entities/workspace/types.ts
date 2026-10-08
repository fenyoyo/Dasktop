/**
 * 工作区按 PowerToys Workspaces 的模型组织：一个工作区保存一组应用窗口的
 * 启动路径和屏幕位置，启动时按记录拉起应用并还原布局。
 */

/**
 * 单个被工作区记录的应用窗口。
 *
 * 以可执行文件路径作为应用身份，因为窗口标题会随打开的文档变化，
 * 而还原时需要的是"启动哪个程序"。
 */
export interface WorkspaceWindow {
  /**
   * 应用专属命令行参数，留空时按系统默认方式启动。
   *
   * 多实例应用（如 VS Code）默认会新建窗口，通过 `--reuse-window`
   * 这类参数可以改为复用已有实例。
   */
  arguments: string;
  /** 进程可执行文件绝对路径，启动和去重都以它为准 */
  executablePath: string;
  /** 窗口高度，单位为物理像素 */
  height: number;
  /**
   * 还原时是否让该应用窗口保持最小化。
   *
   * 用于把「随工作区一起打开但暂时不需要看」的应用先行收起，
   * 例如常驻后台的聊天工具或监控面板。
   */
  minimized: boolean;
  /** 窗口标题，仅用于界面展示 */
  title: string;
  /** 窗口宽度，单位为物理像素 */
  width: number;
  /** 窗口左上角 X 坐标，单位为物理像素 */
  x: number;
  /** 窗口左上角 Y 坐标，单位为物理像素 */
  y: number;
}

/**
 * 一个完整的工作区定义。
 */
export interface Workspace {
  /** 创建时间戳，用于列表排序 */
  createdAt: number;
  /** 工作区唯一标识 */
  id: string;
  /** 用户命名的工作区名称 */
  name: string;
  /** 该工作区包含的应用窗口列表 */
  windows: WorkspaceWindow[];
}

/**
 * 单个应用的还原结果，用于展示启动状态。
 */
export interface WorkspaceRestoreResult {
  executablePath: string;
  /** 失败原因，成功时为空字符串 */
  message: string;
  /** 该应用是否复用了已运行的实例 */
  reusedExisting: boolean;
  success: boolean;
}

/**
 * 还原过程中的状态分级，用于给用户展示差异化的进度反馈。
 */
export type WorkspaceRestoreStatus = "pending" | "success" | "reused" | "failed";
