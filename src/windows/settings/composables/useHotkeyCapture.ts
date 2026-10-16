import { nextTick, onUnmounted } from "vue";

/**
 * 捕获组合键时忽略的「裸修饰键」：它们单独按下不组成完整组合键，等主键落下再一起记录。
 */
const HOTKEY_MODIFIER_KEYS = new Set([
  "Control",
  "Alt",
  "Shift",
  "Meta",
  "Win",
  "OS",
]);

/**
 * 从按键事件里取出主键名。
 *
 * 优先用 `event.code`（物理键位，如 `KeyT` / `Digit1` / `F5`），而不是 `event.key`：
 * 按住 `Alt` 时 `event.key` 经常被输入法、死键或 AltGr 吞掉 / 改写成奇怪的值，导致
 * 只捕获到修饰键、主键丢失，结果存进空串、状态停在「未配置快捷键」。物理键位不受这些影响。
 */
function keyFromEvent(event: KeyboardEvent): string | null {
  const code = event.code;
  if (/^Key[A-Z]$/.test(code)) {
    return code.slice(3); // KeyT -> T
  }
  if (/^Digit[0-9]$/.test(code)) {
    return code.slice(5); // Digit1 -> 1
  }
  if (/^Numpad[0-9]$/.test(code)) {
    return code.slice(6); // Numpad1 -> 1
  }
  if (/^F([1-9]|1[0-2])$/.test(code)) {
    return code; // F1..F12 原样保留
  }

  const named: Record<string, string> = {
    Space: "Space",
    ArrowUp: "ArrowUp",
    ArrowDown: "ArrowDown",
    ArrowLeft: "ArrowLeft",
    ArrowRight: "ArrowRight",
    Backspace: "Backspace",
    Delete: "Delete",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
  };
  if (named[code]) {
    return named[code];
  }

  // 其它单字符键（符号等）退回 event.key，统一大写保证稳定。
  if (event.key && event.key.length === 1) {
    return event.key.toUpperCase();
  }
  return null;
}

/**
 * 捕获过程中的三个回调。
 *
 * 组合键的**取值方式**（读物理键位、忽略裸修饰键）是两类热键共用的，但「取到之后写进谁的
 * 草稿、回车提交到哪条配置、Esc 取消哪一行」各家不同，因此由调用方注入而不是写死在这里。
 */
export interface HotkeyCaptureHandlers {
  /** 捕获到完整组合键时回调，形如 `Alt+T` / `Ctrl+Alt+T`。 */
  onCapture: (accelerator: string) => void;
  /** 用户按回车确认。 */
  onCommit: () => void;
  /** 用户按 Esc / Tab 放弃本次改键。 */
  onCancel: () => void;
}

/**
 * 设置页的组合键捕获控制器。
 */
export interface HotkeyCaptureController {
  /**
   * 开始捕获：挂 window 级捕获监听，并把焦点给回退输入框。
   *
   * `fallbackFocusId` 指向编辑态里那个只读输入框；它只是兜底（见 `startCapture` 实现注释），
   * 不传也能工作。
   */
  startCapture: (fallbackFocusId?: string) => void;
  /** 结束捕获：撤掉监听。幂等，未开始时调用无副作用。 */
  stopCapture: () => void;
  /**
   * 输入框自身 `keydown` 的入口，行为与 window 级捕获一致。
   *
   * 挂上它是因为极少数平台 window 级捕获拿不到物理键位，聚焦后的输入框还能兜底抓一次。
   */
  handleKeydown: (event: KeyboardEvent) => void;
}

/**
 * 抽出设置页「按下组合键即捕获」的交互，供插件热键行与全局快捷键行共用。
 *
 * 必须是「按下即捕获」而不是普通文本输入：快捷键是组合键，用户在普通文本框里敲不出
 * `Alt+T`（按住 Alt 时浏览器不会往输入框写字），结果就是保存了一个空串、状态始终停在
 * 「未配置快捷键」。这里在 keydown 里直接读修饰键与主键、拼成字符串，并 `preventDefault`
 * 挡掉浏览器/系统对组合键的默认响应（如 Alt 拉起菜单），否则捕获到的不会是用户想绑的键。
 *
 * 监听挂在 window 上而非输入框上：热键是「按下即捕获」，不能依赖输入框获得焦点——
 * 它在 `v-for` 内、又是只读框，某些平台收不到 keydown，聚焦还会因为 `v-for` 的 ref
 * 被收集成数组而落空。
 *
 * 必须在组件 `setup` 期间调用：内部依赖 `onUnmounted` 兜底撤监听，避免编辑态未结束就
 * 切走面板时把监听泄漏到别的面板。
 */
export function useHotkeyCapture(
  handlers: HotkeyCaptureHandlers,
): HotkeyCaptureController {
  /** 当前挂在 window 上的捕获监听及其移除函数；无编辑态时为 `null`。 */
  let removeCaptureListener: (() => void) | null = null;

  function stopCapture(): void {
    removeCaptureListener?.();
    removeCaptureListener = null;
  }

  function handleKeydown(event: KeyboardEvent): void {
    // 回车提交、Esc 取消；Tab 不当成主键，直接放过去避免把焦点切换吞掉。
    if (event.key === "Enter") {
      handlers.onCommit();
      return;
    }
    if (event.key === "Escape" || event.key === "Tab") {
      handlers.onCancel();
      return;
    }

    // 单独按下修饰键只是组合键的前奏，此刻还不完整，不能记录。
    if (HOTKEY_MODIFIER_KEYS.has(event.key)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const tokens: string[] = [];
    if (event.ctrlKey) tokens.push("Ctrl");
    if (event.altKey) tokens.push("Alt");
    if (event.shiftKey) tokens.push("Shift");
    if (event.metaKey) tokens.push("Meta");

    const key = keyFromEvent(event);
    if (key) {
      tokens.push(key);
    }

    handlers.onCapture(tokens.join("+"));
  }

  function startCapture(fallbackFocusId?: string): void {
    // 从一行切到另一行改键时，先把前一个编辑态的 window 监听撤掉，避免按键同时写两份草稿。
    stopCapture();

    const handler = (event: KeyboardEvent): void => handleKeydown(event);
    window.addEventListener("keydown", handler, true);
    removeCaptureListener = (): void =>
      window.removeEventListener("keydown", handler, true);

    if (fallbackFocusId) {
      // 焦点只是回退手段：极少数平台 window 级捕获拿不到物理键位时，聚焦后的输入框
      // 还能兜底抓一次。用 id 定位，避开 v-for 的 ref 数组陷阱。
      void nextTick(() => document.getElementById(fallbackFocusId)?.focus());
    }
  }

  onUnmounted(stopCapture);

  return { handleKeydown, startCapture, stopCapture };
}
