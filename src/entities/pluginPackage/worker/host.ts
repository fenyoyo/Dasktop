import type {
  PluginPermission,
  PluginUiNode,
  PluginWorkerInbound,
  PluginWorkerOutbound,
} from "../types";
import { createPluginHostBridge } from "../context";
import runtimeSource from "./runtime.js?raw";

/**
 * 插件 Worker 的主线程宿主。
 *
 * 职责边界很明确：本模块只管「进程外」的事情——创建 Worker、路由消息、管生命周期。
 * 真正的权限校验在 `createPluginHostBridge`，渲染在传入的 `onUiRender`。
 *
 * 安全性依据：Worker 与主线程只通过可结构化克隆的消息通信，插件无论怎么破坏 Worker
 * 内部状态，能触达宿主的入口都只有这里的 `rpc` 分支，而该分支会逐次校验权限。
 */

/** 宿主等待插件完成激活的时间上限（毫秒）。 */
const ACTIVATION_TIMEOUT_MS = 10_000;

/** 宿主等待插件完成卸载的时间上限（毫秒）。超过则直接终止 Worker。 */
const DEACTIVATION_TIMEOUT_MS = 3_000;

/**
 * 启动插件 Worker 所需的输入。
 */
export interface StartPluginWorkerOptions {
  /** 宿主版本号，透传给插件。 */
  hostVersion: string;
  /** 插件下发界面描述时的回调，由窗口渲染器消费。 */
  onUiRender?: (tree: PluginUiNode) => void;
  /** 经加载期预检后实际授予的权限。 */
  permissions: readonly PluginPermission[];
  /** 插件唯一标识，同时作为所有宿主调用的归属标识。 */
  pluginId: string;
  /** 插件版本号。 */
  pluginVersion: string;
  /** 插件入口源码。 */
  source: string;
}

/**
 * 已启动插件的句柄。
 */
export interface PluginWorkerHandle {
  /** 请求插件收尾并终止 Worker。 */
  deactivate: () => Promise<void>;
  /** 立即终止 Worker，不再请求插件收尾。 */
  dispose: () => void;
  /** 把界面交互回传给插件。 */
  sendUiEvent: (action: string, payload?: unknown) => void;
}

/**
 * 在独立 Worker 中启动插件并等待其激活完成。
 *
 * 激活失败会 reject：调用方据此把插件标记为加载失败，而不是让它带着半初始化状态留在列表里。
 */
export async function startPluginWorker(
  options: StartPluginWorkerOptions,
): Promise<PluginWorkerHandle> {
  const { hostVersion, onUiRender, permissions, pluginId, pluginVersion, source } = options;

  const { revoke, worker } = createPluginWorker(pluginId, source);
  const bridge = createPluginHostBridge({ permissions, pluginId });

  let disposed = false;
  let settled = false;
  let resolveActivation: (() => void) | null = null;
  let rejectActivation: ((error: Error) => void) | null = null;
  let resolveDeactivation: (() => void) | null = null;

  const post = (message: PluginWorkerInbound) => {
    if (!disposed) {
      worker.postMessage(message);
    }
  };

  const handleMessage = (event: MessageEvent) => {
    const data = event.data as PluginWorkerOutbound;

    switch (data.kind) {
      case "activated": {
        if (!settled) {
          settled = true;
          resolveActivation?.();
        }

        return;
      }

      case "deactivated": {
        resolveDeactivation?.();

        return;
      }

      case "error": {
        // 激活阶段的错误要打断等待；卸载阶段的错误只影响卸载流程，
        // 由 `deactivate` 内部的超时兜底，不再向外抛。
        if (!settled) {
          settled = true;
          rejectActivation?.(new Error(data.message));
        }

        return;
      }

      case "rpc": {
        void bridge.handle(data.method, data.args).then(
          (value) => post({ id: data.id, kind: "rpc-result", ok: true, value }),
          (error) => post({ error: describeError(error), id: data.id, kind: "rpc-result", ok: false }),
        );

        return;
      }

      case "ui-render": {
        // 界面下发同样要过权限：Worker 侧虽然按 `ui:panel` 裁剪过 `host.ui`，
        // 但插件完全可以绕开代理直接 `postMessage` 一条 ui-render，所以判据必须在宿主这边。
        // 越权时静默丢弃而不是回报错误——不给插件一个探测自身授权状态的信道。
        if (permissions.includes("ui:panel")) {
          onUiRender?.(data.tree);
        }

        return;
      }
    }
  };

  const handleError = (event: ErrorEvent) => {
    // Worker 脚本自身的语法错误不会走 message 通道，只能靠 error 事件捕获；
    // 不接住的话激活会一直挂到超时，错误原因也随之丢失。
    if (!settled) {
      settled = true;
      rejectActivation?.(new Error(event.message || "插件 Worker 启动失败"));
    }
  };

  worker.addEventListener("message", handleMessage);
  worker.addEventListener("error", handleError);

  const activation = new Promise<void>((resolve, reject) => {
    resolveActivation = resolve;
    rejectActivation = reject;
  });

  const activationTimer = setTimeout(() => {
    if (settled) {
      return;
    }

    settled = true;
    rejectActivation?.(
      new Error(`插件激活超过 ${Math.round(ACTIVATION_TIMEOUT_MS / 1000)} 秒未完成，已终止`),
    );
  }, ACTIVATION_TIMEOUT_MS);

  post({
    config: { hostVersion, permissions, pluginId, pluginVersion },
    kind: "init",
  });

  try {
    await activation;
  } catch (error) {
    clearTimeout(activationTimer);
    dispose();

    throw error;
  }

  clearTimeout(activationTimer);

  function dispose(): void {
    if (disposed) {
      return;
    }

    disposed = true;
    worker.removeEventListener("message", handleMessage);
    worker.removeEventListener("error", handleError);
    worker.terminate();
    revoke();
  }

  async function deactivate(): Promise<void> {
    if (disposed) {
      return;
    }

    // 先置位再终止：插件在收尾过程中若卡死，`settled` 不会再被激活路径改写。
    settled = true;

    const finished = new Promise<void>((resolve) => {
      resolveDeactivation = resolve;
    });

    post({ kind: "deactivate" });

    await Promise.race([finished, delay(DEACTIVATION_TIMEOUT_MS)]);

    dispose();
  }

  function sendUiEvent(action: string, payload?: unknown): void {
    post({ action, kind: "ui-event", payload });
  }

  return { deactivate, dispose, sendUiEvent };
}

/**
 * 把运行时与插件源码拼成 module worker 的入口。
 *
 * 刻意不用「Worker 内 `import(blobUrl)`」的写法：拼接让模块作用域、求值顺序与错误
 * 定位都完全确定，也不依赖各内核在 Worker 中对 blob 模块解析的实现差异。代价是插件源码
 * 与运行时共享顶层作用域，因此运行时统一使用 `__dasktop` 前缀（见 `runtime.js`）。
 */
function createPluginWorker(
  pluginId: string,
  source: string,
): { revoke: () => void; worker: Worker } {
  const entry = `${runtimeSource}\n\n/* ---- 插件源码：${pluginId} ---- */\n${source}\n`;

  const url = URL.createObjectURL(new Blob([entry], { type: "text/javascript" }));
  const worker = new Worker(url, { name: `dasktop-plugin-${pluginId}`, type: "module" });

  // Blob URL 要等 Worker 完成加载才能回收：构造是异步取源码的过程，
  // 立即 revoke 会让加载失败。这里把回收推迟到 dispose，代价只是一个
  // 几十 KB 的 Blob 在插件存活期间常驻。
  return { revoke: () => URL.revokeObjectURL(url), worker };
}

/**
 * 把任意异常收敛成可读字符串。
 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : "插件调用失败，原因未知";
}

/**
 * 最小延迟工具，用于给卸载流程加超时。
 */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
