#!/usr/bin/env node
/**
 * 插件包契约验证脚本。
 *
 * 用法：`node scripts/verify-plugins.mjs`
 *
 * 存在意义：插件运行在 Web Worker 里，入口以字符串拼接后动态 import，
 * 因此 `tsc` / `vite build` 对 `plugins/` 目录**零覆盖**。改坏一个导出名、写错一个
 * 界面字段，构建照样通过，只有运行时才发现——而那时的报错往往只是一句
 * 「插件入口必须导出 activate(host)」。
 *
 * 这里在 Node 里复刻宿主侧最小环境来堵住这个缺口：
 * - 用**真实的** `worker/runtime.js` 与插件源码拼接，拼接顺序与宿主完全一致；
 * - 用一个假的 `self` 承接 `postMessage`，按主线程的规则分派消息、按清单门控能力；
 * - 断言导出契约、权限门控、RPC 链路、界面树是否符合声明式 UI 协议。
 *
 * 脚本刻意不引入任何依赖，也不需要先跑 `pnpm install`。
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const PLUGINS_ROOT = path.join(PROJECT_ROOT, "plugins");
const RUNTIME_PATH = path.join(
  PROJECT_ROOT,
  "src",
  "entities",
  "pluginPackage",
  "worker",
  "runtime.js",
);

/**
 * 注入假 Worker 全局所用的全局变量名。
 *
 * 不在导入前直接改写 `globalThis.self`：多个插件是**顺序**加载的，而插件内部
 * 可能存在尚未结算的异步链；共享一个全局会让 A 的残留回调把消息投进 B 的模拟器。
 * 改为在 bundle 顶部声明 `const self = globalThis.<这个名字>`，让每个 bundle 在
 * 模块作用域里持有自己的引用，加载完立刻删掉全局变量即可彻底解耦。
 */
const WORKER_SELF_GLOBAL = "__dasktopVerifySelf";

/** 插件入口允许出现的导出名。 */
const KNOWN_EXPORTS = ["activate", "deactivate", "onUiEvent"];

/**
 * 清单允许声明的权限。
 *
 * 与 `src/entities/pluginPackage/types.ts` 的 `PLUGIN_PERMISSIONS` 手工对齐：
 * 本脚本是纯 Node ESM，读不到 TS 源。宿主扩了权限而此处漏改时，合法清单会被误判成
 * 非法——属于「响亮的失败」，可以接受；反过来漏删才危险，因此新增权限务必同步这里。
 */
const KNOWN_PERMISSIONS = [
  "fs:read",
  "fs:write",
  "log:write",
  "net:request",
  "ui:notify",
  "ui:panel",
];

/** RPC 方法名 → 所需权限，与 `src/entities/pluginPackage/permissions.ts` 一致。 */
const METHOD_PERMISSION = {
  "fs.read": "fs:read",
  "fs.write": "fs:write",
  "log.write": "log:write",
  "net.request": "net:request",
  notify: "ui:notify",
};

/**
 * 界面协议：节点类型 → 允许 / 必填字段。
 *
 * 同时校验「多余字段」是刻意为之：渲染器只认识表里列出的字段，多写的字段会被静默
 * 忽略，作者会以为生效了却没有任何效果——这类错误比缺字段更难排查。
 */
const UI_NODE_SPEC = {
  text: { allowed: ["tone", "type", "value"], required: ["value"] },
  button: { allowed: ["action", "label", "tone", "type"], required: ["action", "label"] },
  input: {
    allowed: ["action", "label", "placeholder", "type", "value"],
    required: ["action"],
  },
  stack: {
    allowed: ["children", "direction", "gap", "type"],
    required: ["children", "direction"],
  },
  card: { allowed: ["children", "title", "type"], required: ["children"] },
  list: { allowed: ["items", "type"], required: ["items"] },
  "key-value": { allowed: ["entries", "type"], required: ["entries"] },
};

/** 各类节点 `tone` 的取值枚举。 */
const UI_TONE_VALUES = {
  button: ["danger", "default", "primary"],
  text: ["muted", "normal", "strong"],
};

/** 界面树最大递归深度，用于拦住插件构造出的环状结构。 */
const UI_MAX_DEPTH = 24;

/* -------------------------------------------------------------------------- */
/* 通用工具                                                                    */
/* -------------------------------------------------------------------------- */

/** 把任意值描述成简短的调试文本。 */
function describeType(value) {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "数组";
  }

  return typeof value;
}

/**
 * 轮询等待条件成立。
 *
 * 插件的激活与交互处理都是异步的，无法用固定次数的微任务推进来保证结算完毕；
 * 轮询一个真实条件比「睡固定时长」既更快也更稳。
 */
async function waitUntil(predicate, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  throw new Error(`等待超时：${label}`);
}

/**
 * 推进若干轮宏任务，把纯微任务组成的异步链彻底排空。
 *
 * 用于「本不该发生某事」的断言：需要先给插件充分机会去做，才能断定它没做。
 */
async function drain(ticks = 3) {
  for (let index = 0; index < ticks; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/* -------------------------------------------------------------------------- */
/* 界面树校验                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 递归校验一棵界面描述树。
 *
 * @param {unknown} node 当前节点
 * @param {string} trail 从根到当前节点的可读路径，用于把失败定位到具体位置
 * @param {number} depth 当前深度
 */
function assertUiTree(node, trail = "root", depth = 0) {
  assert.ok(depth <= UI_MAX_DEPTH, `${trail} 超过 ${UI_MAX_DEPTH} 层，疑似环状结构`);
  assert.ok(
    node !== null && typeof node === "object" && !Array.isArray(node),
    `${trail} 应为对象，实际是 ${describeType(node)}`,
  );

  const spec = UI_NODE_SPEC[node.type];
  assert.ok(
    spec,
    `${trail} 使用了未知节点类型 ${JSON.stringify(node.type)}；` +
      `渲染器只认识 ${Object.keys(UI_NODE_SPEC).join(" / ")}`,
  );

  for (const key of Object.keys(node)) {
    assert.ok(
      spec.allowed.includes(key),
      `${trail} 出现渲染器不认识的字段 \`${key}\`，它会被静默忽略`,
    );
  }

  for (const key of spec.required) {
    assert.ok(node[key] !== undefined, `${trail} 缺少必填字段 \`${key}\``);
  }

  if (node.tone !== undefined) {
    const values = UI_TONE_VALUES[node.type] ?? [];
    assert.ok(
      values.includes(node.tone),
      `${trail}.tone 取值 ${JSON.stringify(node.tone)} 不在 ${values.join(" / ")} 内`,
    );
  }

  if (node.type === "text") {
    assert.equal(typeof node.value, "string", `${trail}.value 应为字符串`);
  }

  if (node.type === "button") {
    assert.equal(typeof node.action, "string", `${trail}.action 应为字符串`);
    assert.equal(typeof node.label, "string", `${trail}.label 应为字符串`);
  }

  if (node.type === "input") {
    assert.equal(typeof node.action, "string", `${trail}.action 应为字符串`);
    for (const key of ["label", "placeholder", "value"]) {
      if (node[key] !== undefined) {
        assert.equal(typeof node[key], "string", `${trail}.${key} 应为字符串`);
      }
    }
  }

  if (node.type === "stack") {
    assert.ok(
      ["column", "row"].includes(node.direction),
      `${trail}.direction 应为 column 或 row`,
    );
    if (node.gap !== undefined) {
      assert.ok(
        ["lg", "md", "none", "sm"].includes(node.gap),
        `${trail}.gap 取值 ${JSON.stringify(node.gap)} 不在 lg / md / none / sm 内`,
      );
    }
  }

  if (node.type === "list") {
    assert.ok(Array.isArray(node.items), `${trail}.items 应为数组`);
    node.items.forEach((item, index) => {
      assert.equal(typeof item, "string", `${trail}.items[${index}] 应为字符串`);
    });
  }

  if (node.type === "key-value") {
    assert.ok(Array.isArray(node.entries), `${trail}.entries 应为数组`);
    node.entries.forEach((entry, index) => {
      assert.ok(
        entry !== null && typeof entry === "object" && !Array.isArray(entry),
        `${trail}.entries[${index}] 应为对象`,
      );
      assert.equal(typeof entry.key, "string", `${trail}.entries[${index}].key 应为字符串`);
      assert.equal(typeof entry.value, "string", `${trail}.entries[${index}].value 应为字符串`);
    });
  }

  if (node.children !== undefined) {
    assert.ok(Array.isArray(node.children), `${trail}.children 应为数组`);
    node.children.forEach((child, index) => {
      assertUiTree(child, `${trail}.children[${index}]`, depth + 1);
    });
  }
}

/** 深度优先遍历界面树。 */
function walkUiTree(node, visit) {
  visit(node);

  if (Array.isArray(node?.children)) {
    for (const child of node.children) {
      walkUiTree(child, visit);
    }
  }
}

/** 收集界面树里所有满足条件的节点。 */
function collectUiNodes(tree, predicate) {
  const found = [];
  walkUiTree(tree, (node) => {
    if (predicate(node)) {
      found.push(node);
    }
  });

  return found;
}

/* -------------------------------------------------------------------------- */
/* 宿主模拟器                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 复刻主线程侧的宿主行为：分派 Worker 消息、按权限门控 RPC、记录全部往来。
 *
 * 与真实宿主的差异只在于「能力用假数据实现」；门控规则与消息形状必须保持一致，
 * 否则这个脚本就退化成自说自话的假测试。
 */
function createHostSimulator(manifest) {
  const granted = new Set(manifest.permissions);
  const allows = (permission) => granted.has(permission);

  /** 模拟插件包目录内的文件，键为包内相对路径。 */
  const files = new Map();
  /** 收到过的 `log.write` 调用。 */
  const logs = [];
  /** 收到过的 `notify` 调用。 */
  const notifications = [];
  /** 收到过的全部 RPC 调用（含被拒的），按到达顺序。 */
  const rpcCalls = [];
  /** 收到过的界面树，按到达顺序。 */
  const uiTrees = [];
  /** 生命周期消息（activated / deactivated）。 */
  const lifecycle = [];
  /** 上报的错误信息。 */
  const errors = [];
  /** 违反权限门控或协议的消息。 */
  const violations = [];

  /** 由 `attach` 注入：把消息投递回 Worker。 */
  let sendToWorker = null;

  const respond = (id, ok, value, error) => {
    sendToWorker({ error: error ?? null, id, kind: "rpc-result", ok, value: value ?? null });
  };

  const handleRpc = (message) => {
    const { args = [], id, method } = message;
    rpcCalls.push({ args, method });

    const required = METHOD_PERMISSION[method];
    if (!required) {
      respond(id, false, null, `未知能力：${method}`);

      return;
    }

    // Worker 侧已按权限裁剪过 `host`，未授权的方法本不该被调到。
    // 真出现了说明裁剪失效，必须记为越权而不是照常执行。
    if (!allows(required)) {
      violations.push(`调用 ${method} 但未声明 ${required}`);

      return;
    }

    switch (method) {
      case "fs.read": {
        const [relativePath] = args;
        if (!files.has(relativePath)) {
          respond(id, false, null, `插件文件不可读 ${relativePath}：文件不存在`);

          return;
        }

        respond(id, true, files.get(relativePath));

        return;
      }

      case "fs.write": {
        const [relativePath, contents] = args;
        files.set(relativePath, contents);
        respond(id, true, null);

        return;
      }

      case "log.write": {
        const [text, level] = args;
        logs.push({ level: level ?? "info", message: text });
        respond(id, true, null);

        return;
      }

      case "net.request": {
        const [request] = args;
        // 真实宿主走 reqwest 发请求；这里只回一个形状正确的响应，
        // 目的是验证插件的请求构造与响应消费，而不是验证 Rust 侧网络实现。
        respond(id, true, {
          body: JSON.stringify({ ok: true, url: request?.url ?? null }),
          headers: { "content-type": "application/json" },
          status: 200,
        });

        return;
      }

      case "notify": {
        const [title, text] = args;
        notifications.push({ message: text, title });
        respond(id, true, null);

        return;
      }

      default: {
        respond(id, false, null, `未实现的能力：${method}`);
      }
    }
  };

  const simulator = {
    /** 注入消息投递函数。 */
    attach(send) {
      sendToWorker = send;
    },

    /** 分派一条 Worker → 宿主消息。 */
    dispatch(message) {
      switch (message?.kind) {
        case "rpc": {
          handleRpc(message);

          return;
        }

        case "ui-render": {
          // 与 `worker/host.ts` 的 ui-render 分支一致：越权时静默丢弃，
          // 不给插件一个探测自身授权状态的信道。
          if (!allows("ui:panel")) {
            violations.push("下发界面但未声明 ui:panel");

            return;
          }

          uiTrees.push(message.tree);

          return;
        }

        case "activated":
        case "deactivated": {
          lifecycle.push(message.kind);

          return;
        }

        case "error": {
          errors.push(message.message);

          return;
        }

        default: {
          violations.push(`收到未知消息类型 ${JSON.stringify(message?.kind)}`);
        }
      }
    },

    errors,
    files,
    lifecycle,
    logs,
    notifications,
    rpcCalls,
    uiTrees,
    violations,
  };

  return simulator;
}

/* -------------------------------------------------------------------------- */
/* 插件加载                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 按宿主的真实加载路径把一个插件跑起来。
 *
 * 拼接顺序与 `worker/host.ts` 一致（运行时在前、插件源码在后），这样插件里对
 * `activate` 的函数声明会被提升，运行时的 `typeof activate` 探测才能拿到它。
 */
async function loadPlugin({ manifest, pluginDir, runtimeSource, tempDir }) {
  const entrySource = await readFile(path.join(pluginDir, manifest.entry), "utf8");

  const bundleSource = [
    `const self = globalThis.${WORKER_SELF_GLOBAL};`,
    runtimeSource,
    entrySource,
  ].join("\n");

  const bundlePath = path.join(tempDir, `${manifest.id}.mjs`);
  await writeFile(bundlePath, bundleSource, "utf8");

  const simulator = createHostSimulator(manifest);

  /** 假的 Worker 全局对象：承接 `self.postMessage` 与 `self.onmessage`。 */
  const fakeSelf = {
    onmessage: null,
    postMessage(message) {
      simulator.dispatch(message);
    },
  };

  globalThis[WORKER_SELF_GLOBAL] = fakeSelf;

  let namespace;
  try {
    namespace = await import(pathToFileURL(bundlePath).href);
  } finally {
    // 模块求值已把引用存进它自己的模块作用域，全局变量使命结束。
    delete globalThis[WORKER_SELF_GLOBAL];
  }

  /** 向 Worker 投递一条消息；未注册 `onmessage` 说明模块没执行到底。 */
  const send = (data) => {
    assert.equal(
      typeof fakeSelf.onmessage,
      "function",
      "Worker 未注册 onmessage，模块可能未执行到底",
    );
    fakeSelf.onmessage({ data });
  };

  simulator.attach(send);

  const settled = () => simulator.errors.length > 0;

  return {
    exports: namespace,
    simulator,

    /** 触发激活并等待结算。 */
    async start(config) {
      send({ config: { ...config, permissions: manifest.permissions }, kind: "init" });
      await waitUntil(
        () => simulator.lifecycle.length > 0 || settled(),
        "插件激活完成（既未上报 activated 也未上报 error）",
      );
    },

    /** 触发卸载并等待结算。 */
    async stop() {
      const before = simulator.errors.length;
      send({ kind: "deactivate" });
      await waitUntil(
        () => simulator.lifecycle.includes("deactivated") || simulator.errors.length > before,
        "插件卸载完成（既未上报 deactivated 也未上报 error）",
      );
    },

    /** 投递一次界面交互；调用方负责等待它引发的后续效果。 */
    uiEvent(action, payload) {
      send({ action, kind: "ui-event", payload });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 场景                                                                        */
/* -------------------------------------------------------------------------- */

/** 所有插件都要满足的契约。 */
function verifyCommonContract(manifest, pluginDir, loaded, directoryName) {
  assert.equal(manifest.id, directoryName, "清单 id 必须与插件包目录名一致");
  assert.ok(typeof manifest.name === "string" && manifest.name.trim(), "清单必须声明非空 name");
  assert.ok(typeof manifest.entry === "string" && manifest.entry.trim(), "清单必须声明非空 entry");
  assert.ok(Array.isArray(manifest.permissions), "清单 permissions 必须是数组");

  for (const permission of manifest.permissions) {
    assert.ok(
      KNOWN_PERMISSIONS.includes(permission),
      `清单声明了未知权限 ${permission}；已登记权限为 ${KNOWN_PERMISSIONS.join(" / ")}`,
    );
  }

  assert.ok(
    !path.isAbsolute(manifest.entry) && !manifest.entry.includes(".."),
    "清单 entry 必须是插件包内的相对路径",
  );

  const { exports } = loaded;
  assert.equal(typeof exports.activate, "function", "插件入口必须导出 activate(host)");

  for (const name of ["deactivate", "onUiEvent"]) {
    if (exports[name] !== undefined) {
      assert.equal(typeof exports[name], "function", `可选导出 ${name} 若存在必须是函数`);
    }
  }

  // 写错的导出名会被宿主静默忽略，插件作者却以为生效了，因此单独点出来。
  const unexpected = Object.keys(exports).filter((name) => !KNOWN_EXPORTS.includes(name));

  return unexpected;
}

/** hello-dasktop：验证 fs 读改写闭环与 notify。 */
async function verifyHelloDasktop(manifest, loaded) {
  const { simulator } = loaded;

  // 预置一份已有状态，用来验证「读回旧值 → 自增 → 写回」真的跑通了。
  // 不预置的话第一轮永远从空状态开始，自增逻辑写错也看不出来。
  simulator.files.set("state.json", JSON.stringify({ activateCount: 4, lastActivatedAt: null }));

  await loaded.start({
    hostVersion: "verify",
    pluginId: manifest.id,
    pluginVersion: manifest.version,
  });

  assert.deepEqual(simulator.errors, [], `激活不应报错：${simulator.errors.join("；")}`);
  assert.deepEqual(simulator.lifecycle, ["activated"], "应只上报一次 activated");

  const written = simulator.files.get("state.json");
  assert.ok(written, "激活后应写回 state.json");

  const state = JSON.parse(written);
  assert.equal(state.activateCount, 5, "activateCount 应在读回旧值的基础上自增");
  assert.equal(typeof state.lastActivatedAt, "string", "应写入激活时间");

  assert.ok(
    simulator.logs.some((entry) => entry.message.includes("已激活")),
    "应有激活日志",
  );
  assert.equal(simulator.notifications.length, 1, "应发出一次通知");
  assert.equal(simulator.notifications[0].message, "示例插件第 5 次激活");

  await loaded.stop();

  assert.deepEqual(simulator.lifecycle, ["activated", "deactivated"], "应上报 deactivated");
  assert.deepEqual(simulator.errors, [], "卸载不应报错");
  assert.ok(
    simulator.logs.some((entry) => entry.message.includes("已卸载")),
    "应有卸载日志",
  );
}

/** http-console：验证界面下发、交互回传、net 请求与状态持久化。 */
async function verifyHttpConsole(manifest, loaded) {
  const { simulator } = loaded;

  assert.equal(
    typeof loaded.exports.onUiEvent,
    "function",
    "http-console 依赖 ui:panel，必须导出 onUiEvent 才能消费交互",
  );

  await loaded.start({
    hostVersion: "verify",
    pluginId: manifest.id,
    pluginVersion: manifest.version,
  });

  assert.deepEqual(simulator.errors, [], `激活不应报错：${simulator.errors.join("；")}`);
  assert.equal(simulator.uiTrees.length, 1, "激活后应下发一帧界面");

  const initialTree = simulator.uiTrees[0];
  assertUiTree(initialTree, "激活帧");
  assert.equal(initialTree.type, "stack", "根节点应为 stack");
  assert.equal(initialTree.direction, "column", "根节点应为纵向排列");

  // 首帧必须是「有输入框、有两个按钮、有两张卡片」的可用界面，而不是一句「加载中」——
  // 用户打开插件窗口时应当立刻能操作。
  const inputs = collectUiNodes(initialTree, (node) => node.type === "input");
  const buttons = collectUiNodes(initialTree, (node) => node.type === "button");
  const cards = collectUiNodes(initialTree, (node) => node.type === "card");

  assert.equal(inputs.length, 1, "首帧应有一个地址输入框");
  assert.equal(inputs[0].action, "setUrl", "地址输入框的 action 应为 setUrl");
  assert.ok(inputs[0].value, "地址输入框应带默认值");

  assert.deepEqual(
    buttons.map((node) => node.action).sort(),
    ["clear", "send"],
    "首帧应有发送与清空两个按钮",
  );
  assert.deepEqual(
    cards.map((node) => node.title),
    ["最近一次结果", "历史"],
    "首帧应有结果与历史两张卡片",
  );

  // 输入过程只记录、不重渲染：重渲染会让输入框重建、光标位置丢失。
  const url = "https://example.com/api";
  loaded.uiEvent("setUrl", url);
  await drain();
  assert.equal(simulator.uiTrees.length, 1, "输入内容不应触发界面重下发");

  loaded.uiEvent("send", null);
  await waitUntil(
    () => simulator.uiTrees.length >= 2 || simulator.errors.length > 0,
    "发送请求后重下发界面",
  );

  assert.deepEqual(simulator.errors, [], `发送请求不应报错：${simulator.errors.join("；")}`);

  const netCalls = simulator.rpcCalls.filter((call) => call.method === "net.request");
  assert.equal(netCalls.length, 1, "应恰好发出一次 net 请求");
  assert.equal(netCalls[0].args.length, 1, "net.request 只应接收一个请求对象");
  assert.equal(netCalls[0].args[0]?.url, url, "请求地址应为输入框里的值");

  const resultTree = simulator.uiTrees[1];
  assertUiTree(resultTree, "结果帧");

  const resultCard = collectUiNodes(resultTree, (node) => node.title === "最近一次结果")[0];
  assert.ok(resultCard, "结果帧应包含「最近一次结果」卡片");

  const statusEntry = resultCard.children
    .flatMap((node) => node.entries ?? [])
    .find((entry) => entry.key === "状态");
  assert.ok(statusEntry, "结果卡片应列出状态字段");
  assert.equal(statusEntry.value, "200", "响应状态应写进结果卡片");

  const historyCard = collectUiNodes(resultTree, (node) => node.title?.startsWith("历史"))[0];
  assert.ok(historyCard, "结果帧应包含历史卡片");

  const historyList = historyCard.children.find((node) => node.type === "list");
  assert.ok(historyList, "历史卡片应包含列表");
  assert.equal(historyList.items.length, 1, "历史应记录一条");
  assert.ok(historyList.items[0].includes(url), "历史条目应包含请求地址");

  assert.ok(simulator.files.has("state.json"), "发送请求后应把状态持久化到 state.json");

  loaded.uiEvent("clear", null);
  await waitUntil(
    () => simulator.uiTrees.length >= 3 || simulator.errors.length > 0,
    "清空历史后重下发界面",
  );

  assert.deepEqual(simulator.errors, [], `清空历史不应报错：${simulator.errors.join("；")}`);

  const clearedTree = simulator.uiTrees[2];
  assertUiTree(clearedTree, "清空帧");

  const clearedHistory = collectUiNodes(clearedTree, (node) => node.title === "历史")[0];
  assert.ok(clearedHistory, "清空后历史卡片标题应回到「历史」以表示条数为零");
  assert.ok(
    clearedHistory.children.some((node) => node.value?.includes("还没有历史记录")),
    "清空后应显示空历史提示",
  );

  // 落盘的必须是「已清空」这一版，而不是发送请求那一版。
  const persisted = JSON.parse(simulator.files.get("state.json"));
  assert.deepEqual(persisted.history, [], "清空后的状态应落盘");
  assert.equal(persisted.url, url, "持久化的地址应为用户输入值");

  await loaded.stop();

  assert.deepEqual(simulator.lifecycle, ["activated", "deactivated"], "应上报 deactivated");
  assert.deepEqual(simulator.errors, [], "卸载不应报错");
}

/** 按 id 分派的专用场景；未登记 id 的插件只跑通用契约。 */
const SCENARIOS = {
  "hello-dasktop": verifyHelloDasktop,
  "http-console": verifyHttpConsole,
};

/* -------------------------------------------------------------------------- */
/* 入口                                                                        */
/* -------------------------------------------------------------------------- */

async function verifyOnePackage({ directoryName, runtimeSource, tempDir }) {
  const pluginDir = path.join(PLUGINS_ROOT, directoryName);
  const manifest = JSON.parse(await readFile(path.join(pluginDir, "plugin.json"), "utf8"));

  const loaded = await loadPlugin({ manifest, pluginDir, runtimeSource, tempDir });

  const unexpectedExports = verifyCommonContract(manifest, pluginDir, loaded, directoryName);

  const scenario = SCENARIOS[manifest.id];
  if (scenario) {
    await scenario(manifest, loaded);
  }

  // 越权调用一律视为失败：这说明 Worker 侧的能力裁剪被绕过了。
  assert.deepEqual(loaded.simulator.violations, [], "不应出现越权调用");

  return { unexpectedExports, hasScenario: Boolean(scenario) };
}

async function main() {
  const runtimeSource = await readFile(RUNTIME_PATH, "utf8");
  const tempDir = await mkdtemp(path.join(tmpdir(), "dasktop-verify-"));

  const entries = await readdir(PLUGINS_ROOT, { withFileTypes: true });
  const packageDirs = entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !entry.name.startsWith(".") && !entry.name.startsWith("_"))
    .map((entry) => entry.name)
    .sort();

  assert.ok(packageDirs.length > 0, `未在 ${PLUGINS_ROOT} 找到任何插件包`);

  const failures = [];
  const warnings = [];

  try {
    for (const directoryName of packageDirs) {
      try {
        const result = await verifyOnePackage({ directoryName, runtimeSource, tempDir });

        console.log(`  ✓ ${directoryName}`);

        if (result.hasScenario) {
          console.log("      通用契约 + 专用场景（生命周期 / 能力门控 / 界面协议）");
        } else {
          console.log("      仅通用契约：未登记专用场景，行为未被覆盖");
        }

        if (result.unexpectedExports.length > 0) {
          warnings.push(
            `${directoryName}：入口导出了 ${result.unexpectedExports.join(" / ")}，` +
              `宿主只会读取 ${KNOWN_EXPORTS.join(" / ")}`,
          );
        }
      } catch (error) {
        failures.push(`${directoryName}：${error.message}`);
        console.log(`  ✗ ${directoryName}`);
      }
    }
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }

  console.log("");

  for (const warning of warnings) {
    console.warn(`警告：${warning}`);
  }

  if (failures.length > 0) {
    console.error(`插件契约校验失败（${failures.length} / ${packageDirs.length} 个包）：`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }

    process.exitCode = 1;

    return;
  }

  console.log(`全部 ${packageDirs.length} 个插件包通过契约校验。`);
}

await main();
