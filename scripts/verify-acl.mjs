#!/usr/bin/env node
/**
 * 应用命令 ACL 验证。
 *
 * 背景：Tauri 只在「应用定义了 ACL manifest」时，才对**应用自己的命令**做权限检查
 * （`tauri/src/webview/mod.rs`：`plugin_command.is_some() || has_app_acl_manifest || !is_local`）。
 * 此前 `src-tauri/permissions/` 不存在，加上插件窗口的 `http://plugin.localhost` 会被判定为
 * **本机来源**，三个条件一起不成立 → 这道检查被整条跳过，插件页面里的 JS 可以无门控地调用
 * 宿主任何一条命令（含 `delete_desktop_items` 这类破坏性操作）。
 *
 * 现在 `permissions/host-commands.toml` 把门关上了。这套机制的失败模式很隐蔽，所以逐条静态校验：
 *
 * 1. **必须存在 app 级权限定义** —— 文件被删掉就等于退回「无门控」，而应用照常能跑，
 *    没有任何症状；
 * 2. **每条已注册命令都必须被「已授予」的 app 权限覆盖** —— 漏一条，那条命令在宿主窗口里
 *    也会被拒，症状是「点了没反应 + 控制台 command not allowed」；
 * 3. **app 权限里不能出现未注册的命令名** —— 拼错或删命令后忘了清，会让鉴权看起来是好的；
 * 4. **任何 capability 都不得覆盖插件窗口** —— 这是整套隔离的地基。WebView 把自定义协议
 *    判定为本机来源，一旦有 capability 匹配 `plugin_*`，插件页面直接拿回全部能力。
 *
 * 零依赖，直接 `node scripts/verify-acl.mjs`。
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const permissionsDir = join(repoRoot, "src-tauri/permissions");
const capabilitiesDir = join(repoRoot, "src-tauri/capabilities");
const libSourcePath = join(repoRoot, "src-tauri/src/lib.rs");

/**
 * 插件窗口标签前缀。与 `src/entities/pluginPackage/window.ts` 的
 * `PLUGIN_WINDOW_LABEL_PREFIX` 必须一致。
 */
const PLUGIN_WINDOW_PREFIX = "plugin_";

/**
 * 用代表性标签验证 capability 的窗口覆盖范围。
 *
 * 宿主窗口取的是真实 label（`box_*` 形态取自 `desktopBox/windows.ts` 的窗口标签，
 * `box_menu` / `drag_preview` 是常量，主窗口由 tauri.conf.json 省略 label 得来，
 * 默认即 `main`）。
 */
const HOST_WINDOW_SAMPLES = ["main", "box_a1b2c3", "box_menu", "drag_preview"];
const PLUGIN_WINDOW_SAMPLES = [`${PLUGIN_WINDOW_PREFIX}hello-dasktop`, `${PLUGIN_WINDOW_PREFIX}http-console`];

const failures = [];

function fail(message) {
  failures.push(message);
}

async function main() {
  const registered = await readRegisteredCommands();
  const appPermissions = await readAppPermissions();
  const capabilities = await readCapabilities();

  checkAppAclExists(appPermissions);
  const granted = resolveGrantedCommands(appPermissions, capabilities);

  checkCommandCoverage(registered, granted);
  checkCapabilityWindowCoverage(capabilities);

  report(registered, appPermissions, capabilities, granted);
}

await main();

/* -------------------------------------------------------------------------- */
/* 读取                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 从 `lib.rs` 的 `invoke_handler(tauri::generate_handler![…])` 里取全部命令名。
 *
 * 命令名取的是路径的最后一段：`commands::desktop::rename_desktop_item` → `rename_desktop_item`，
 * 与运行时 IPC 收到的 `request.cmd` 一致。
 */
async function readRegisteredCommands() {
  const source = await readFile(libSourcePath, "utf8");
  const block = source.match(/generate_handler!\[([\s\S]*?)\]/);

  if (!block) {
    throw new Error("未能从 src-tauri/src/lib.rs 解析出 generate_handler! 的命令列表");
  }

  const commands = new Set();

  for (const match of block[1].matchAll(/([A-Za-z_][A-Za-z0-9_:]*)\s*,/g)) {
    commands.add(match[1].split("::").pop());
  }

  return commands;
}

/**
 * 读取 `src-tauri/permissions/*.toml` 里的 app 级权限定义。
 */
async function readAppPermissions() {
  const definitions = new Map();

  for (const fileName of await listDirectory(permissionsDir, ".toml")) {
    const source = await readFile(join(permissionsDir, fileName), "utf8");

    // app 权限集（[default]）会让本脚本的「已授予」推导失去准确性：届时需要按
    // 权限集展开引用。与其算错还不如明确报错，免得校验静默失真。
    if (/^\s*\[default\]/m.test(source)) {
      fail(`${fileName} 使用了 app 权限集 [default]，scripts/verify-acl.mjs 尚未支持，请先扩展脚本`);
      continue;
    }

    for (const block of source.split(/\[\[permission\]\]/).slice(1)) {
      const identifier = block.match(/^\s*identifier\s*=\s*"([^"]+)"/m)?.[1];

      if (!identifier) {
        fail(`${fileName} 里有一处 [[permission]] 缺少 identifier`);
        continue;
      }

      if (identifier.includes(":")) {
        fail(`${fileName} 的权限标识「${identifier}」带了前缀：app 级权限不能带前缀，否则会被当成插件权限`);
        continue;
      }

      definitions.set(identifier, {
        allow: extractStringArray(block, "commands.allow"),
        fileName,
      });
    }
  }

  return definitions;
}

/**
 * 读取 `src-tauri/capabilities/*.json`。
 */
async function readCapabilities() {
  const capabilities = [];

  for (const fileName of await listDirectory(capabilitiesDir, ".json")) {
    const parsed = JSON.parse(await readFile(join(capabilitiesDir, fileName), "utf8"));

    // capability 可以写成单个对象或对象数组。
    for (const capability of Array.isArray(parsed) ? parsed : [parsed]) {
      const permissions = (capability.permissions ?? []).map((entry) =>
        typeof entry === "string" ? entry : entry.identifier,
      );

      capabilities.push({
        fileName,
        identifier: capability.identifier ?? fileName,
        permissions,
        webviews: capability.webviews ?? capability.windows ?? [],
        windows: capability.windows ?? [],
      });
    }
  }

  return capabilities;
}

/* -------------------------------------------------------------------------- */
/* 校验                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * app 级权限定义必须存在——它是应用命令受鉴权的唯一前提。
 */
function checkAppAclExists(appPermissions) {
  if (appPermissions.size === 0) {
    fail(
      "src-tauri/permissions/ 下没有任何 app 级权限定义。缺少它时 Tauri 会跳过应用命令的权限检查，插件页面可以无门控调用宿主全部命令",
    );
  }
}

/**
 * 把 capability 引用的 app 权限展开成「实际已授予的命令集合」。
 */
function resolveGrantedCommands(appPermissions, capabilities) {
  const granted = new Map();

  for (const capability of capabilities) {
    for (const permission of capability.permissions) {
      // 带前缀的是插件（core: / sql: / autostart:）权限，不归本脚本管。
      if (permission.includes(":")) {
        continue;
      }

      const definition = appPermissions.get(permission);

      if (!definition) {
        fail(
          `capability「${capability.identifier}」引用了 app 权限「${permission}」，但 src-tauri/permissions/ 下没有它的定义`,
        );
        continue;
      }

      for (const command of definition.allow) {
        if (!granted.has(command)) {
          granted.set(command, []);
        }

        granted.get(command).push(capability.identifier);
      }
    }
  }

  return granted;
}

/**
 * 已注册命令与已授予命令必须一一对应。
 */
function checkCommandCoverage(registered, granted) {
  for (const command of [...registered].sort()) {
    if (!granted.has(command)) {
      fail(
        `命令「${command}」已注册但没有被任何 capability 授予：宿主窗口调用它会被拒。把它加进 src-tauri/permissions/host-commands.toml`,
      );
    }
  }

  for (const command of [...granted.keys()].sort()) {
    if (!registered.has(command)) {
      fail(`app 权限里列了命令「${command}」，但它不在 lib.rs 的 invoke_handler 里（拼写错误，或删命令后忘了同步权限文件）`);
    }
  }
}

/**
 * 任何 capability 都不得覆盖插件窗口。
 */
function checkCapabilityWindowCoverage(capabilities) {
  const hostCovered = new Set();

  for (const capability of capabilities) {
    const patterns = [...capability.windows, ...capability.webviews];

    for (const sample of PLUGIN_WINDOW_SAMPLES) {
      if (patterns.some((pattern) => matchesWindowPattern(pattern, sample))) {
        fail(
          `capability「${capability.identifier}」的模式 ${patterns.join("、")} 覆盖了插件窗口「${sample}」。插件窗口一律不能进入白名单——WebView 把插件页面判定为本机来源，一旦授权就等于绕过全部能力门控`,
        );
      }
    }

    for (const sample of HOST_WINDOW_SAMPLES) {
      if (patterns.some((pattern) => matchesWindowPattern(pattern, sample))) {
        hostCovered.add(sample);
      }
    }
  }

  for (const sample of HOST_WINDOW_SAMPLES) {
    if (!hostCovered.has(sample)) {
      fail(`宿主窗口「${sample}」没有被任何 capability 覆盖，它调不动任何命令`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 工具                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * capability 的窗口模式支持 `*` 通配。
 */
function matchesWindowPattern(pattern, label) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");

  return new RegExp(`^${escaped}$`).test(label);
}

/**
 * 从一段 TOML 片段里取 `key = ["a", "b"]` 形式的字符串数组。
 */
function extractStringArray(source, key) {
  const escapedKey = key.replace(/\./g, "\\.").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
  const match = source.match(new RegExp(`${escapedKey}\\s*=\\s*\\[([\\s\\S]*?)\\]`));

  if (!match) {
    return [];
  }

  const body = match[1]
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

  return [...body.matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}

/**
 * 列出目录下指定后缀的文件。
 */
async function listDirectory(directory, suffix) {
  const entries = await readdir(directory, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => entry.name)
    .sort();
}

/**
 * 输出结果。
 */
function report(registered, appPermissions, capabilities, granted) {
  console.log("应用命令 ACL 验证\n");

  console.log(`  已注册命令        ${registered.size} 条`);
  console.log(`  app 权限定义      ${appPermissions.size} 条（${[...appPermissions.keys()].join("、") || "无"}）`);
  console.log(`  已授予命令        ${granted.size} 条`);

  for (const capability of capabilities) {
    const appPermissionsOf = capability.permissions.filter((item) => !item.includes(":"));
    console.log(
      `  capability ${capability.identifier.padEnd(12)} 窗口 ${[...capability.windows, ...capability.webviews].join("、")} · app 权限 ${appPermissionsOf.join("、") || "无"}`,
    );
  }

  console.log(`\n  插件窗口样本 ${PLUGIN_WINDOW_SAMPLES.join("、")} 均未被任何 capability 覆盖`);

  console.log("");

  if (failures.length === 0) {
    console.log("通过");
    return;
  }

  console.log(`发现 ${failures.length} 个问题：`);

  for (const failure of failures) {
    console.log(`  - ${failure}`);
  }

  process.exitCode = 1;
}
