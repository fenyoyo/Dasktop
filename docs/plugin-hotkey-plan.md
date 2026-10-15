# 插件全局热键与快捷窗口

> 状态：**规划，未开工**。基于 `dev`，并假设 `feat/plugin-window-default-size`（插件窗口尺寸）已合入。
>
> **定位：这是通用框架能力，不是翻译功能。** 任意插件都能在清单里声明热键，按下去宿主就把它
> 唤起；唤起之后做什么完全由插件自己决定。翻译插件只是第一个使用者——它恰好选择去读剪贴板。

## 一、目标

- 任意插件声明全局热键，应用未获得焦点、甚至只驻留托盘时也能按下唤起
- 宿主统一负责注册、唯一性裁决、冲突上报、用户级覆盖与禁用
- 「唤起」的语义只有一条：**把插件窗口显示并聚焦**。不做任何插件特定的事

### v1 边界

- 不做「热键直达某个子页面」：一个插件一个窗口（`plugin_<id>`），热键带 `hotkeyId` 交给页面自己路由
- 不做插件运行期动态注册/注销：声明式，随扫描与设置变更生效
- 不做划词翻译、剪贴板轮询——那些是插件页面的事，宿主不参与也不该知道

## 二、现状盘点

**已有**（不用重做）

| 能力 | 落点 |
|---|---|
| 插件包框架：清单解析、能力桥注入、资源协议、建窗 | `services/plugin/{mod,protocol,bridge}.rs` + `bridge.js` |
| 剪贴板文本读写（`clipboard:read/write`） | `commands/plugin.rs` → `infrastructure/windows/text_clipboard.rs` |
| HTTP 代发（`net:request`，20s 超时 / 2MB 上限 / native-tls） | `commands/plugin.rs::plugin_http_request` |
| 窗口尺寸三级优先级与关闭写回 | `services/plugin/window_preference.rs` + `domain/plugin/window_size.rs` |
| 示例包播种与契约校验 | `domain/plugin/sample.rs`、`scripts/verify-plugins.mjs`、`scripts/verify-acl.mjs` |

**缺的**（本次要补）

1. 全局热键：全仓无 hotkey 概念，`Cargo.toml` 也没有对应插件
2. 快捷浮层窗口形态：现有插件窗口有标题栏、进任务栏、关闭即销毁
3. 「本次是被热键唤起」这个意图从宿主传到插件页面的通道
4. 用户级覆盖存储、跨插件唯一性裁决与注册失败上报

## 三、端到端链路

两条路径，区别在于窗口是否已经存在。载荷统一为 `{ pluginId, hotkeyId, at }`。

**路径 A：窗口不存在（首次唤起）**

```text
按热键 ──► 全局热键回调（Rust 宿主）
  └─► 查注册表得 pluginId/hotkeyId ──► spawn 到 async runtime
      └─► open_plugin_window ──► 初始化脚本注入 __DASKTOP_PENDING_HOTKEY__
          └─► 页面启动 → dasktop.hotkey.consume() 取走意图 → 插件自行处理
```

**路径 B：窗口已存在**

```text
按热键 ──► 回调 ──► 窗口可见且聚焦且 kind=quick → hide（切换收起）
                └─► 否则 show + set_focus（不重新导航）
                    └─► emit dasktop://plugin-hotkey ──► dasktop.hotkey.onTrigger(cb)
```

两条路径必须并存：事件只有在页面挂上监听之后才收得到，**首次建窗时页面还没加载完，emit 一定
丢**，所以首建只能靠注入；窗口已存在时反过来，走事件最直接。

## 四、设计决策

### D1 热键是「声明式宿主行为」，不进权限集合

注册由宿主在扫描/启动时完成，插件不需要调任何 IPC。而 `entities/pluginPackage/permissions.ts`
的每一条权限都绑定一条命令，`verify-acl` 靠它推导「插件窗口该被授予哪些命令」——
加一条没有命令的权限会破坏这个推导。

被否方案：新增 `hotkey:register` 权限。代价是把「清单里写了个热键」和「运行时能调命令」混在一起。

代价与补偿：声明即生效，没有权限门。**因此设置页必须集中列出所有插件的热键并允许禁用**，
让用户一眼看到「哪些插件在系统里挂了快捷键」。

### D2 依赖选 `tauri-plugin-global-shortcut`

Rust `~2.4.x` ↔ NPM `@tauri-apps/plugin-global-shortcut` 2.4.1（与 `@tauri-apps/api` 2.11 同一条
2.x 线；crates.io 最新是 3.0.0-alpha.3，稳定线取 2.x，版本以实际解析为准）。

备选：纯 Win32 `RegisterHotKey`。`windows` crate 已开启 `Win32_UI_Input_KeyboardAndMouse`，
零新增依赖，但要自建线程 + message-only window + `GetMessage` 消息泵，accelerator 解析也得自己写。
**若官方插件版本或编译出问题，退回此方案。**

### D3 热键回调里建窗必须先 spawn 到 async runtime

已知坑：建窗若发生在主线程同步上下文里，WebView2 会在 IPC 回调中同步创建第二个 controller，
等消息循环 → **主线程死锁**（插件窗口空白 + 宿主界面一起卡死）。热键回调很可能被代理到主线程。

做法：回调里只做「查注册表 → `tauri::async_runtime::spawn` → 复用
`services::plugin::open_plugin_window`」，不重写建窗逻辑。

### D4 `window.kind` 决定外观与生命周期，**与热键正交**

热键解决「怎么叫醒」，`kind` 解决「醒来长什么样」。两者可以任意组合：

- `standard`（默认）：有标题栏、进任务栏、关闭即销毁 —— 不写 `kind` 的插件行为完全不变
- `quick`：无边框 + 透明 + 置顶 + 不进任务栏 + 不可缩放 + 居中，关闭改隐藏

所以「快捷窗口」不只服务于热键：设置页点「打开」打开一个 quick 插件，行为一致。
反过来，标准窗口也能被热键唤起，只是唤起后是个普通窗口。

### D5 关闭语义：quick 窗口隐藏而非销毁

`CloseRequested` → 先写回尺寸 → `prevent_close()` → `hide()`。销毁再建要重新加载页面，
「按下去立刻出结果」就没了，滚动位置与状态也一起丢。

- 现有 `tray::handle_window_close_requested` 只对设置窗生效（按 label 判断），quick 分支是新增的，不冲突
- 退出链路走 `destroy()`，不经过 `CloseRequested`，不受 `prevent_close` 影响

**失焦即隐**：宿主监听 `WindowEvent::Focused(false)` → hide。
坑：建窗后焦点可能尚未稳定、甚至立刻来一次失焦 → 加「armed 窗口」，建窗后 300ms 内忽略失焦。

**ESC 与主动隐藏**：v1 不做。页面没有 `core:window` 关不掉自己，要支持就得新增一条宿主命令，
而它会落进「插件窗口被授予的命令」集合、牵动 `verify-acl` 的分类。失焦即隐已覆盖绝大多数场景，
留到 v1.1 与「页面画关闭按钮」一起做——好处是 v1 完全不用改 ACL 校验。

### D6 快捷窗口不吃标准窗口的全局默认尺寸

560×640 的全局默认对浮层太大。优先级：

```text
清单 window.width/height  >  quick 面板默认（480×320，进 contract.rs）  >  下限（320×200）
```

仍逐维回落、仍过 clamp，复用 `window_preference::resolve_window_size`，只是兜底常量不同。

### D7 用户覆盖存新表 `plugin_hotkeys`

主键 `(plugin_id, hotkey_id)`，字段 `accelerator` / `enabled`。
优先级：用户覆盖 > 清单默认；`enabled = false` 即不注册。
写回后整批重新注册（unregister all → register），不做增量——增量容易漏掉已卸载的插件。

### D8 唯一性裁决与失败上报，都由宿主做

Windows 上系统保留组合（如 `Ctrl+C`、含 Win 键）注册失败是**静默**的，没有任何异常；
同一组合被两个插件声明时，后注册的那个也会静默失败。

- 裁决顺序：宿主自身热键（将来有）→ 插件按 id 字典序。先到先得，后来者标记为「与他人冲突」不注册
- 失败项收集成列表随扫描结果返回，设置页红字说明原因（被系统保留 / 与某插件冲突 / 被其它程序占用）
- 没有这条反馈，用户看到的只有「按了没反应」

### D9 意图传递双通道（见第三节）

首建走 `initialization_script` 注入的 `__DASKTOP_PENDING_HOTKEY__`；已存在窗口走事件
`dasktop://plugin-hotkey`。桥上新增 `dasktop.hotkey.consume()` / `dasktop.hotkey.onTrigger(cb)`。

`hotkey` 命名空间**不进 `CAPABILITY_TABLE`**——它不对应任何权限，不是能力，只是宿主把
「你被叫醒了」告诉页面。校验脚本据此也不会要求清单声明权限。

### D10 再按一次的行为由 `kind` 推导，不新增字段

- `quick`：**切换**。窗口可见且聚焦时再按 = 收起（浮层是临时态，再按一次让它消失符合直觉）
- `standard`：**只唤起并聚焦**（幂等）。文档型窗口被按一下就藏起来会让人困惑

这条从语义自然推出，不需要清单再加开关。将来若某个插件要反过来，再补 `hotkeys[].mode`。

### D11 桥配置带上声明的热键，页面可自渲染提示

`bridge.rs` 注入的 `__DASKTOP_BRIDGE__` 增加 `hotkeys` 数组（`{ id, accelerator, title }`）。
页面因此能自己显示「按 Alt+T 翻译剪贴板」这类提示，不必再向宿主问一遍。

## 五、清单契约

```jsonc
{
  "id": "translator",
  "entry": "index.html",
  "permissions": ["clipboard:read", "clipboard:write", "net:request"],
  // kind: "standard"（默认，可省略）| "quick"
  "window": { "kind": "quick", "width": 520, "height": 360 },
  "hotkeys": [
    { "id": "translate", "accelerator": "Alt+T", "title": "翻译剪贴板内容" }
  ]
}
```

校验（`verify-plugins.mjs` 新增）：

- `hotkeys[].id` 在包内唯一，只含 `[a-z0-9-]`
- `accelerator` 必须**至少一个修饰键 + 一个主键**（裸 `T` 会吞掉全局输入，必须拦住）；
  含 `Super`/`Win` 的组合直接拒绝（系统保留，注册必失败，不如在扫描期就说清）
- `window.kind` 只允许 `standard` / `quick`
- 示例包自动纳入校验

## 六、改动清单

**Rust**

- `Cargo.toml`：新增 `tauri-plugin-global-shortcut`；`lib.rs` 注册插件
- `domain/plugin/contract.rs`：`PLUGIN_HOTKEY_EVENT`、`PLUGIN_QUICK_WINDOW_SIZE`、
  `PLUGIN_QUICK_WINDOW_MIN_SIZE`
- `domain/plugin/manifest.rs`：清单增 `window.kind`、`hotkeys`
- `infrastructure/`（新）：热键底层注册/反注册与 accelerator 解析校验
- `services/plugin/`（新）：注册表编排——扫描后整批注册、回调里 spawn 建窗、唯一性裁决、失败收集
- `services/plugin/mod.rs`：`open_plugin_window` 支持 `kind: quick`（外观、关闭语义、失焦即隐、切换收起）
- `services/plugin/window_preference.rs`：quick 窗口走另一组兜底常量
- `services/plugin/bridge.rs`：注入配置增加 `hotkeys`
- `commands/plugin.rs` + `lib.rs`：`list_plugin_hotkeys` / `set_plugin_hotkey`（宿主窗口调用）

**前端**

- `entities/pluginPackage/types.ts`：清单类型、热键定义与注册状态类型
- `entities/pluginPackage/loader.ts`：快照携带全部热键的注册状态
- `shared/storage/database.ts`：`plugin_hotkeys` 表读写
- `windows/settings/panels/PluginsPanel.vue`：集中「快捷键」小节（全部插件）+ 卡片内展示
- `windows/settings/composables/useSettingsPlugins.ts`：接线

**能力桥**

- `bridge.js`：新增 `dasktop.hotkey` 命名空间（不进 `CAPABILITY_TABLE`）

**校验脚本**

- `verify-plugins.mjs`：见第五节
- `verify-acl.mjs`：v1 不新增插件可调命令 → **无需改动**（这也是 D5 把 ESC 推后的收益）

## 七、第一个使用者：`plugins/translator`

```jsonc
{
  "id": "translator",
  "permissions": ["clipboard:read", "clipboard:write", "net:request"],
  "window": { "kind": "quick", "width": 520, "height": 360 },
  "hotkeys": [{ "id": "translate", "accelerator": "Alt+T", "title": "翻译剪贴板内容" }]
}
```

页面：顶栏（语言选择 + 复制结果）、原文区、译文区、状态区（加载 / 错误 / 剪贴板为空）。
逻辑要点：

- 收到唤起意图后**先读剪贴板**，为空或非文本 → 明确提示，不静默
- **同一段文本连续两次不重复请求**（连按两次是常态）
- provider 失败自动降级到下一个源
- 历史记录用 `localStorage`，**key 必须带 `translator:` 前缀**——所有插件共享同一个 origin
- 顶栏提示语直接读桥配置里的 `hotkeys`，不硬编码 `Alt+T`

翻译源候选（v1 默认值待实测后定，按此序降级）：

| 源 | 鉴权 | 额度 | 备注 |
|---|---|---|---|
| MyMemory | 匿名即可，填 email 提额 | 匿名约 5000 字符/天/IP | 公开 API，适合自用低频 |
| LibreTranslate | 公共实例免鉴权，自建更佳 | 公共实例常被限流 | 允许填自建地址 |
| 有道 / 百度 / DeepL | AppID + Key | 免费额度或按量 | 稳定合规，需用户配置 |

**如实写清**：免鉴权源只适合自用低频，稳定性与商用合规都不保证。落地前先在国内网络下实测可达性。

播种注意：`SAMPLE_PACKAGES` 只在「插件根下无子目录」时播种，**老用户运行目录不会自动补写**，
需手动补给或清空重播（连带 `.js` 一起，漏了页面引用的脚本会 404）。

## 八、其他插件怎么用

最小可用——一个「按热键弹出待办清单」的插件，全程只用到唤起这一件事：

```jsonc
{ "id": "todo", "entry": "index.html", "permissions": [],
  "window": { "kind": "quick", "width": 420, "height": 560 },
  "hotkeys": [{ "id": "toggle", "accelerator": "Alt+Space", "title": "呼出待办" }] }
```

```js
dasktop.hotkey.consume();                 // 首建时被唤起过？取走意图
dasktop.hotkey.onTrigger(() => refresh()); // 之后再被唤起
```

翻译插件与它走的是**同一条链路**，区别只在页面拿到意图之后做了什么。这就是把热键做成框架能力
而不是翻译功能的原因。

## 九、验收清单

- `cargo check --tests` / `cargo test --lib` / `vue-tsc --noEmit` / `vite build` 全绿
- `pnpm verify:plugins` / `pnpm verify:acl` 通过
- 手工：按热键唤起插件（**首次与第二次都要测**，两条路径不同）
- 手工：主窗口隐藏、只驻留托盘时，热键仍能唤起
- 手工：quick 插件再按一次 = 收起；standard 插件再按一次 = 聚焦（不藏）
- 手工：点别处 → quick 浮层消失；再按热键 → 立刻再出现且页面状态保留
- 手工：两个插件声明同一组合 → 设置页显示「与 X 冲突」且只有一个生效
- 手工：把热键改成 `Ctrl+C` → 设置页显示注册失败
- 手工：设置页禁用热键 → 按下不再唤起
- 回归：不写 `kind`、不写 `hotkeys` 的既有插件行为完全不变

## 十、风险与未决

- **热键只在进程运行时有效** → 依赖自启 / 托盘常驻（已有 autostart 与托盘）
- **唤起会抢走当前应用的焦点**，这是「唤起」的应有之义，但要确认不会打断正在进行的输入
- 免鉴权翻译源的额度、可达性与合规（见第七节，只影响示例包，不影响框架）
- 未决：ESC / 主动隐藏是否进 v1（牵动一条新命令与 `verify-acl` 分类）
- 未决：翻译源默认值待实测
- 未决：多显示器下 quick 窗口居中取主屏还是光标所在屏
- 未决：将来宿主自身若有热键（如唤起主面板），须注册在插件之前并纳入同一张冲突表
