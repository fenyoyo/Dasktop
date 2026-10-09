/**
 * 插件 Worker 运行时。
 *
 * 本文件不是普通模块：宿主以字符串形式读出它，与插件源码拼接后作为 module worker
 * 的入口执行。因此这里有两条必须遵守的约束：
 *
 * 1. **不 import 任何宿主模块** —— Worker 里既没有宿主模块系统，也没有 `window`、
 *    `document` 或 Tauri 注入对象，插件越界访问这些东西时会直接拿到 undefined；
 * 2. **顶层标识符统一加 `__dasktop` 前缀** —— 拼接意味着与插件源码共享同一模块作用域，
 *    不加前缀的通用名（如 `config`、`pending`）会与插件自己的顶层声明冲突并导致语法错误。
 *
 * 运行时只做三件事：把宿主能力调用转成消息、按权限裁剪出代理对象、驱动插件生命周期。
 * 真正的权限校验不在这里 —— Worker 内代码一律不可信，校验发生在主线程。
 */

const __dasktopPending = new Map();
const __dasktopConfig = { current: null };
let __dasktopNextRequestId = 1;

/**
 * 向宿主发起一次能力调用。
 *
 * 失败时 reject 一个普通 Error：插件侧只需要 `try/catch` 就能拿到可读原因，
 * 不需要理解宿主内部的错误类型。
 */
function __dasktopCallHost(method, args) {
  return new Promise((resolve, reject) => {
    const id = __dasktopNextRequestId;
    __dasktopNextRequestId += 1;

    __dasktopPending.set(id, { reject, resolve });
    self.postMessage({ args, id, kind: "rpc", method });
  });
}

/**
 * 按授权权限裁剪出宿主能力代理。
 *
 * 与主线程侧的裁剪保持一致：未声明 `fs:read` 的插件拿到的是一个没有 `read` 成员的
 * `fs` 对象，因此插件必须在调用前做能力判定，而不是靠捕获异常掩盖权限缺失。
 */
function __dasktopCreateHost(config) {
  const granted = config.permissions;
  const allows = (permission) => granted.indexOf(permission) >= 0;

  const host = {
    hostVersion: config.hostVersion,
    permissions: granted.slice(),
    pluginId: config.pluginId,
    pluginVersion: config.pluginVersion,
  };

  if (allows("fs:read") || allows("fs:write")) {
    const fs = {};

    if (allows("fs:read")) {
      fs.read = (path) => __dasktopCallHost("fs.read", [path]);
    }

    if (allows("fs:write")) {
      fs.write = (path, contents) => __dasktopCallHost("fs.write", [path, contents]);
    }

    host.fs = fs;
  }

  if (allows("log:write")) {
    host.log = {
      error: (message) => __dasktopCallHost("log.write", [message, "error"]),
      info: (message) => __dasktopCallHost("log.write", [message, "info"]),
      write: (message, level) => __dasktopCallHost("log.write", [message, level || "info"]),
    };
  }

  if (allows("net:request")) {
    host.net = {
      request: (request) => __dasktopCallHost("net.request", [request]),
    };
  }

  if (allows("ui:notify")) {
    host.notify = (title, message) => __dasktopCallHost("notify", [title, message]);
  }

  if (allows("ui:panel")) {
    host.ui = {
      /**
       * 下发一棵界面描述树。宿主渲染完成后回传 `ui-event` 消息。
       *
       * 这里不做任何校验，只负责转发：节点合法性与渲染方式由主线程决定，
       * 插件永远无法通过构造特殊节点把任意 HTML 送进宿主页面。
       */
      render: (tree) => {
        self.postMessage({ kind: "ui-render", tree });

        return Promise.resolve();
      },
    };
  }

  return host;
}

/** 把任意异常收敛成可读字符串。 */
function __dasktopDescribeError(error) {
  if (error && typeof error.message === "string") {
    return error.message;
  }

  return String(error);
}

/** 执行插件激活。 */
async function __dasktopStart() {
  try {
    if (typeof activate !== "function") {
      self.postMessage({ kind: "error", message: "插件入口必须导出 activate(host) 函数" });

      return;
    }

    await activate(__dasktopCreateHost(__dasktopConfig.current));
    self.postMessage({ kind: "activated" });
  } catch (error) {
    self.postMessage({ kind: "error", message: __dasktopDescribeError(error) });
  }
}

/** 执行插件卸载。`deactivate` 是可选导出。 */
async function __dasktopStop() {
  try {
    if (typeof deactivate === "function") {
      await deactivate(__dasktopCreateHost(__dasktopConfig.current));
    }

    self.postMessage({ kind: "deactivated" });
  } catch (error) {
    self.postMessage({ kind: "error", message: __dasktopDescribeError(error) });
  }
}

self.onmessage = (event) => {
  const data = event.data || {};

  if (data.kind === "init") {
    __dasktopConfig.current = data.config;
    __dasktopStart();

    return;
  }

  if (data.kind === "rpc-result") {
    const entry = __dasktopPending.get(data.id);
    if (!entry) {
      return;
    }

    __dasktopPending.delete(data.id);

    if (data.ok) {
      entry.resolve(data.value);
    } else {
      entry.reject(new Error(data.error));
    }

    return;
  }

  if (data.kind === "deactivate") {
    __dasktopStop();

    return;
  }

  // 界面交互回传：插件可选导出 `onUiEvent(action, payload)` 来消费。
  // 用 `typeof` 探测未声明的标识符是安全的，插件没有该导出时不会抛错。
  if (data.kind === "ui-event" && typeof onUiEvent === "function") {
    onUiEvent(data.action, data.payload);
  }
};
