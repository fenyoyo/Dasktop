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
   * 该窗口是否被收起。
   *
   * 捕获时窗口处于最小化状态就记为 true，还原流程会先把它摆到记录的位置
   * 再收起，用户展开时仍回到原位；界面上可以手动覆盖，用于让「随工作区
   * 一起打开但暂时不需要看」的应用先行收起，例如常驻后台的聊天工具。
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
  /**
   * 应用全部还原完成后按填写顺序执行的附加命令。
   *
   * 用于补齐「宿主应用起来了但内部服务还没起来」的场景：例如捕获了
   * Docker Desktop，再在这里填 `docker start mysql`，启动工作区时就会
   * 在 Docker Desktop 就位后自动拉起容器。命令交给系统 cmd 执行。
   */
  commands: string[];
  /** 创建时间戳，用于列表排序 */
  createdAt: number;
  /** 工作区唯一标识 */
  id: string;
  /**
   * 相邻两次应用启动之间的等待秒数，0 表示不等待。
   *
   * 还原时应用逐个启动并等待窗口出现，连续启动多个重型应用会同时抢占
   * 磁盘与 CPU，用固定间隔错峰可以明显改善启动过程。
   */
  launchIntervalSeconds: number;
  /** 用户命名的工作区名称 */
  name: string;
  /** 该工作区包含的应用窗口列表 */
  windows: WorkspaceWindow[];
}

/**
 * 单条附加命令的执行结果。
 */
export interface WorkspaceCommandResult {
  /** 用户填写的命令原文，前端据此匹配展示条目 */
  command: string;
  /** 失败原因或命令输出摘要，成功且无输出时为空字符串 */
  message: string;
  /** 该命令是否以 0 退出 */
  success: boolean;
}

/**
 * 单次还原的完整结果，应用与命令分开返回。
 *
 * 两者身份来源不同（应用靠可执行文件路径匹配、命令靠填写顺序匹配），
 * 分开承载可以让前端各自映射，不需要额外的类型判别字段。
 */
export interface WorkspaceRestoreOutcome {
  /** 附加命令的执行结果，按填写顺序 */
  commands: WorkspaceCommandResult[];
  /** 应用窗口的还原结果，顺序与传入的窗口列表一致 */
  windows: WorkspaceRestoreResult[];
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
