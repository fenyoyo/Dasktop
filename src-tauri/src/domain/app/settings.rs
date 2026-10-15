//! 应用设置契约常量；当前设置由前端 SQLite 插件写入，Rust 侧保留同名契约避免后续重复硬编码。

/// 应用数据库 URL，必须与前端 `APP_SETTINGS_STORAGE.databaseUrl` 保持一致。
pub const APP_DATABASE_URL: &str = "sqlite:dasktop.db";

/// 应用 SQLite 表名，必须与前端 `APP_SETTINGS_STORAGE.tables` 保持一致。
pub mod tables {
    /// 全局应用设置表。
    pub const APP_SETTINGS: &str = "app_settings";
    /// Box 内文件排序表。
    pub const BOX_ITEM_ORDERS: &str = "box_item_orders";
    /// Box 内 Shell 虚拟项表。
    pub const BOX_VIRTUAL_ITEMS: &str = "box_virtual_items";
    /// Box 实例表。
    pub const BOXES: &str = "boxes";
    /// 插件包级窗口尺寸表，主键为插件 id；全局默认值仍走 `app_settings`。
    pub const PLUGIN_WINDOW_SIZES: &str = "plugin_window_sizes";
    /// 系统桌面图标接管状态表。
    pub const SHELL_ICON_VISIBILITY_RECORDS: &str = "shell_icon_visibility_records";
}

/// 应用设置表名，保留直观别名供只关心设置表的 Rust 逻辑使用。
pub const APP_SETTINGS_TABLE: &str = tables::APP_SETTINGS;

/// 应用设置键名，必须与前端 `APP_SETTING_KEYS` 保持一致。
pub mod keys {
    /// Box 背景透明度百分比。
    pub const BOX_BACKGROUND_OPACITY: &str = "boxBackgroundOpacity";
    /// Box 收缩和展开动画持续时间。
    pub const BOX_COLLAPSE_ANIMATION_MS: &str = "boxCollapseAnimationMs";
    /// 鼠标离开 Box 后等待收缩的延迟时间。
    pub const BOX_COLLAPSE_DELAY_MS: &str = "boxCollapseDelayMs";
    /// Box 文件名标签换行宽度。
    pub const BOX_FILENAME_WIDTH: &str = "boxFilenameWidth";
    /// Box 整体和图标命中区域圆角。
    pub const BOX_CORNER_RADIUS: &str = "boxCornerRadius";
    /// Box 闲置透明度淡出动画持续时间。
    pub const BOX_IDLE_OPACITY_HIDE_ANIMATION_MS: &str = "boxIdleOpacityHideAnimationMs";
    /// Box 闲置透明度淡入动画持续时间。
    pub const BOX_IDLE_OPACITY_SHOW_ANIMATION_MS: &str = "boxIdleOpacityShowAnimationMs";
    /// Box 图标列之间的横向间距。
    pub const BOX_ICON_GAP_X: &str = "boxIconGapX";
    /// Box 图标行之间的纵向间距。
    pub const BOX_ICON_GAP_Y: &str = "boxIconGapY";
    /// Box 图标显示尺寸。
    pub const BOX_ICON_SIZE: &str = "boxIconSize";
    /// Box 文件名标签字号。
    pub const BOX_LABEL_TEXT_SIZE: &str = "boxLabelTextSize";
    /// Box 手动 resize 是否按图标网格吸附。
    pub const BOX_RESIZE_GRID_ENABLED: &str = "boxResizeGridEnabled";
    /// Box 传输遇到同名文件时的处理策略，必须与前端 `BoxConflictPolicy` 保持同名语义。
    pub const BOX_CONFLICT_POLICY: &str = "boxConflictPolicy";
    /// 删除 Box 时真实文件夹的处理策略，必须与前端 `BoxDeletePolicy` 保持同名语义。
    pub const BOX_DELETE_POLICY: &str = "boxDeletePolicy";
    /// Box 文件拖出到桌面后的处理策略，必须与前端 `BoxDropAction` 保持同名语义。
    pub const BOX_DRAG_OUT_ACTION: &str = "boxDragOutAction";
    /// 外部文件拖入 Box 后的处理策略，必须与前端 `BoxDropAction` 保持同名语义。
    pub const BOX_DROP_ACTION: &str = "boxDropAction";
    /// Box 窗口主题模式。
    pub const BOX_THEME: &str = "boxTheme";
    /// 新建 Box 的真实文件夹根目录；修改后只影响后续 Box，历史 Box 使用自身 `folderPath`。
    pub const COLLECTION_ROOT_PATH: &str = "collectionRootPath";
    /// Box 内文件是否使用双击打开。
    pub const DOUBLE_CLICK_OPEN_ITEMS: &str = "doubleClickOpenItems";
    /// Box 文件名展示规则。
    pub const NAME_DISPLAY_MODE: &str = "nameDisplayMode";
    /// 插件窗口默认高度（逻辑像素），未为单个插件单独记住尺寸时按其开窗。
    pub const PLUGIN_WINDOW_HEIGHT: &str = "pluginWindowHeight";
    /// 插件窗口默认宽度（逻辑像素），未为单个插件单独记住尺寸时按其开窗。
    pub const PLUGIN_WINDOW_WIDTH: &str = "pluginWindowWidth";
    /// 设置页主题模式。
    pub const SETTINGS_THEME: &str = "settingsTheme";
    /// 系统桌面图标进入 Box 后是否自动隐藏 Windows 原生入口。
    pub const AUTO_HIDE_NATIVE_SHELL_ICONS: &str = "autoHideNativeShellIcons";
    /// Box 内是否显示文件名标签。
    pub const SHOW_ITEM_LABELS: &str = "showItemLabels";
    /// Box 内快捷方式是否显示角标。
    pub const SHOW_SHORTCUT_ARROW: &str = "showShortcutArrow";
    /// Box 吸附阈值。
    pub const SNAP_THRESHOLD: &str = "snapThreshold";
    /// Box 是否吸附屏幕或其他 Box 边缘。
    pub const SNAP_TO_EDGES: &str = "snapToEdges";
}
