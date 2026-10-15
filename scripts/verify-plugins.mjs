#!/usr/bin/env node
/**
 * 插件包契约验证。
 *
 * 插件界面是插件包里的网页与脚本，完全不在 TypeScript 的覆盖范围内——`vue-tsc` 与
 * `vite build` 都不会看一眼 `plugins/` 目录。清单里文件名写错、页面里的引用指向不存在的
 * 文件、模块没被任何页面引入、用了没声明过的宿主能力，这些问题构建阶段全都发现不了，
 * 要等用户打开插件窗口才暴露，而那时候他能看到的只是一片空白或者「点了没反应」。
 *
 * 这个脚本把这几类检查提到提交前：
 *
 * 1. 清单可解析、id 与目录名一致、entry 非空且指向 HTML 并真实存在；
 * 2. 清单声明的权限都在宿主已知集合内，且与 Rust 侧的权限常量集合一致；
 * 3. 包内每个 HTML / JS 里的相对引用都指向真实存在的文件，且没有逃出包目录；
 * 4. 包内每个 `.js` 都被某处引用到——写好了却没人引入，运行期就是一段死代码；
 * 5. 脚本里出现的每一处 `dasktop.<命名空间>.<方法>(...)` 都在能力桥的映射表里，
 *    且对应权限已在清单中声明；
 * 6. 插件窗口尺寸的允许范围与兜底值在前端常量与 Rust 常量里一致，
 *    清单 `window` 字段里的数值也在该范围内。
 *
 * 零依赖，直接 `node scripts/verify-plugins.mjs`，不需要先跑 `pnpm install`。
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginsRoot = join(repoRoot, "plugins");
const typesPath = join(repoRoot, "src/entities/pluginPackage/types.ts");
const contractPath = join(repoRoot, "src-tauri/src/domain/plugin/contract.rs");
const bridgePath = join(repoRoot, "src-tauri/src/services/plugin/bridge.js");

/**
 * 与宿主扫描保持一致的目录跳过规则：`.` 与 `_` 开头的目录是留给宿主与作者自己的。
 */
const RESERVED_PREFIXES = "._";

/**
 * 从 HTML 里挑出 href / src 属性。不引 HTML 解析器：这里只需要属性值，
 * 一层正则足够，也避免为一个校验脚本引入依赖。
 */
const HTML_REF_PATTERN = /(?:href|src)\s*=\s*["']([^"']*)["']/gi;

/**
 * 从 JS 里挑出模块引用：`from "./x.js"`、`import "./x.js"`、`import("./x.js")`。
 */
// 模块说明符不允许跨行：`[^"'\r\n]+` 排除了换行，避免把一段多行代码当成跨行字符串引用。
const JS_REF_PATTERN = /(?:from\s*|import\s*\(?\s*)["']([^"'\r\n]+)["']/g;

/**
 * 能力桥方法的调用点：`dasktop.net.request(`。
 *
 * 只认这种「三段且带括号」的写法，`dasktop.has(...)` 与 `dasktop.plugin.id` 都不会命中。
 */
const BRIDGE_CALL_PATTERN = /\bdasktop\.([a-z]+)\.([a-z]+)\s*\(/g;

/**
 * 不需要做存在性检查的引用前缀。
 */
const EXTERNAL_PREFIXES = ["//", "data:", "http:", "https:", "javascript:", "mailto:", "tel:"];

/**
 * 带 scheme 的模块说明符（`https://…`、`data:…`）。这些交给 WebView 自己解析，
 * 不按包内文件处理。
 */
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

/**
 * 包内相对引用的解析基准。
 *
 * 借用 URL 解析器做 `./`、`../` 的规范化，比手写路径拼接可靠：它天然处理越界回退
 * （`../../x` 会落到根上），剩下的判断只是「结果还在不在插件目录下」。
 */
const PROTOCOL_ORIGIN = "http://plugin.localhost";

const failures = [];
const results = [];

/**
 * 记录一条失败。刻意不在发现第一条时就中断：一次跑完拿到完整清单，
 * 比反复「改一个、再跑一次」省事得多。
 */
function fail(pluginId, message) {
  failures.push({ message, pluginId });
}

async function main() {
  const knownPermissions = await loadKnownPermissions();
  const bridgeCapabilities = await loadBridgeCapabilities();
  const windowSizeLimits = await loadWindowSizeLimits();
  const pluginIds = await listPluginDirectories();

  for (const pluginId of pluginIds) {
    results.push(
      await verifyPackage(
        pluginId,
        knownPermissions,
        bridgeCapabilities,
        windowSizeLimits,
      ),
    );
  }

  report();
}

await main();

/* -------------------------------------------------------------------------- */
/* 读取宿主侧的权威定义                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 读取宿主认识的权限集合，并核对前后端两份定义一致。
 *
 * 两份定义分处 Rust 与 TypeScript，是必然的重复；与其假装只有一份，不如让脚本比对它们。
 * 漂移的后果是插件声明了权限却在运行期被自己的宿主拒绝，而清单看起来完全正常。
 */
async function loadKnownPermissions() {
  const frontend = await parseFrontendPermissions();
  const backend = await parseBackendPermissions();

  if (frontend.size === 0 || backend.size === 0) {
    throw new Error("未能解析出权限集合，请检查 types.ts 与 contract.rs 的写法是否被改动");
  }

  for (const permission of frontend) {
    if (!backend.has(permission)) {
      fail(
        "（宿主）",
        `前端 PLUGIN_PERMISSIONS 里的「${permission}」在 Rust 的 contract.rs 里没有对应常量`,
      );
    }
  }

  for (const permission of backend) {
    if (!frontend.has(permission)) {
      fail(
        "（宿主）",
        `Rust 的 contract.rs 定义了「${permission}」，但前端 PLUGIN_PERMISSIONS 里没有它`,
      );
    }
  }

  return frontend;
}

async function parseFrontendPermissions() {
  const source = await readFile(typesPath, "utf8");
  const block = source.match(/export const PLUGIN_PERMISSIONS = \[([\s\S]*?)\] as const;/);

  if (!block) {
    throw new Error("未能从 src/entities/pluginPackage/types.ts 解析出 PLUGIN_PERMISSIONS");
  }

  return new Set([...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]));
}

async function parseBackendPermissions() {
  const source = await readFile(contractPath, "utf8");

  return new Set(
    [...source.matchAll(/pub const PLUGIN_PERMISSION_[A-Z_]+:\s*&str\s*=\s*"([^"]+)"/g)].map(
      (match) => match[1],
    ),
  );
}

/**
 * 读取宿主侧的插件窗口尺寸边界，并核对前后端两份定义一致。
 *
 * 这份边界同时被三处使用：设置页数字输入框的可选范围、清单 `window` 字段的夹取范围、
 * 以及宿主建窗时传给 WebView 的下限。三者一旦漂移，用户会得到一个「配了没生效」的窗口，
 * 而任何一侧都毫无异常——比对成本远低于排查成本。
 */
async function loadWindowSizeLimits() {
  const frontend = await parseFrontendWindowSize();
  const backend = await parseBackendWindowSize();

  const comparisons = [
    ["默认宽度", frontend.defaultWidth, backend.default?.width],
    ["默认高度", frontend.defaultHeight, backend.default?.height],
    ["宽度下限", frontend.width.min, backend.min?.width],
    ["宽度上限", frontend.width.max, backend.max?.width],
    ["高度下限", frontend.height.min, backend.min?.height],
    ["高度上限", frontend.height.max, backend.max?.height],
  ];

  for (const [label, expected, actual] of comparisons) {
    if (expected !== actual) {
      fail(
        "（宿主）",
        `插件窗口尺寸的「${label}」在 types.ts 与 contract.rs 里不一致：前端为 ${expected}，后端为 ${actual}`,
      );
    }
  }

  return { height: frontend.height, width: frontend.width, quickMin: backend.quickMin };
}

async function parseFrontendWindowSize() {
  const source = await readFile(typesPath, "utf8");
  const limits = source.match(
    /export const PLUGIN_WINDOW_SIZE_LIMITS = \{([\s\S]*?)\n\} as const;/,
  );

  if (!limits) {
    throw new Error("未能从 src/entities/pluginPackage/types.ts 解析出 PLUGIN_WINDOW_SIZE_LIMITS");
  }

  const defaults = source.match(
    /export const PLUGIN_WINDOW_DEFAULT_SIZE: PluginWindowSize = \{([\s\S]*?)\n\};/,
  );

  if (!defaults) {
    throw new Error("未能从 src/entities/pluginPackage/types.ts 解析出 PLUGIN_WINDOW_DEFAULT_SIZE");
  }

  const readDimension = (block, dimension) => {
    const item = block.match(new RegExp(`${dimension}:\\s*\\{([^}]*)\\}`));

    if (!item) {
      throw new Error(`未能从 PLUGIN_WINDOW_SIZE_LIMITS 解析出 ${dimension}`);
    }

    return {
      max: readNumberIn(item[1], "max"),
      min: readNumberIn(item[1], "min"),
    };
  };

  return {
    defaultHeight: readNumberIn(defaults[1], "height"),
    defaultWidth: readNumberIn(defaults[1], "width"),
    height: readDimension(limits[1], "height"),
    width: readDimension(limits[1], "width"),
  };
}

async function parseBackendWindowSize() {
  const source = await readFile(contractPath, "utf8");
  const readPair = (name) => {
    const found = source.match(
      new RegExp(`pub const ${name}: \\(f64, f64\\) = \\(([\\d.]+), ([\\d.]+)\\)`),
    );

    if (!found) {
      return null;
    }

    return { width: Number(found[1]), height: Number(found[2]) };
  };

  return {
    default: readPair("PLUGIN_WINDOW_SIZE"),
    max: readPair("PLUGIN_WINDOW_MAX_SIZE"),
    min: readPair("PLUGIN_WINDOW_MIN_SIZE"),
    quickMin: readPair("PLUGIN_QUICK_WINDOW_MIN_SIZE"),
  };
}

/**
 * 从一个片段里读出指定数值字段。
 */
function readNumberIn(source, field) {
  const found = source.match(new RegExp(`${field}:\\s*([\\d.]+)`));

  if (!found) {
    throw new Error(`未能解析出数值字段 ${field}`);
  }

  return Number(found[1]);
}

/**
 * 读取能力桥的「方法 → 权限」映射表。
 *
 * 表在 `bridge.js` 顶部，格式是刻意约定好的（一行一项，`"命名空间.方法": "权限"`），
 * 这样校验脚本不必解析 JavaScript 就能拿到权威映射——插件实际用到的方法能不能调，
 * 判据就是这张表。
 */
async function loadBridgeCapabilities() {
  const source = await readFile(bridgePath, "utf8");
  const block = source.match(/CAPABILITY_TABLE\s*=\s*\{([\s\S]*?)\n\s*\};/);

  if (!block) {
    throw new Error("未能从 services/plugin/bridge.js 解析出 CAPABILITY_TABLE");
  }

  const table = new Map();

  for (const match of block[1].matchAll(/"([a-z]+\.[a-z]+)"\s*:\s*"([^"]+)"/g)) {
    table.set(match[1], match[2]);
  }

  if (table.size === 0) {
    throw new Error("services/plugin/bridge.js 的 CAPABILITY_TABLE 是空的");
  }

  return table;
}

/**
 * 列出全部插件包目录。
 */
async function listPluginDirectories() {
  const entries = await readdir(pluginsRoot, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory() && !RESERVED_PREFIXES.includes(entry.name[0]))
    .map((entry) => entry.name)
    .sort();
}

/* -------------------------------------------------------------------------- */
/* 校验单个插件包                                                              */
/* -------------------------------------------------------------------------- */

async function verifyPackage(
  pluginId,
  knownPermissions,
  bridgeCapabilities,
  windowSizeLimits,
) {
  const packageDir = join(pluginsRoot, pluginId);
  const empty = { bridgeCalls: 0, files: 0, pages: 0, pluginId, refs: 0 };
  const manifest = await readManifest(pluginId, packageDir);

  if (!manifest) {
    return empty;
  }

  if (manifest.id !== pluginId) {
    fail(pluginId, `清单 id「${manifest.id}」与目录名「${pluginId}」不一致`);
  }

  verifyWindowPreference(pluginId, manifest.window, windowSizeLimits);

  const declared = new Set(manifest.permissions ?? []);

  for (const permission of declared) {
    if (!knownPermissions.has(permission)) {
      fail(pluginId, `声明了宿主不认识的能力：${permission}`);
    }
  }

  if (typeof manifest.entry !== "string" || manifest.entry.trim() === "") {
    fail(pluginId, "清单未声明 entry");

    return empty;
  }

  const entry = resolveInsidePackage(pluginId, manifest.entry);
  if (!entry) {
    fail(pluginId, `entry「${manifest.entry}」越出了插件包目录`);

    return empty;
  }

  if (!/\.html?$/i.test(manifest.entry)) {
    fail(pluginId, `entry「${manifest.entry}」不是 HTML 文件`);
  }

  if (!existsSync(entry.filePath)) {
    fail(pluginId, `entry「${manifest.entry}」不存在`);
  }

  const htmlFiles = await collectFiles(packageDir, /\.html?$/i);
  const scriptFiles = await collectFiles(packageDir, /\.m?js$/i);

  const referenced = new Set();
  const refCount = await verifyReferences(pluginId, packageDir, htmlFiles, scriptFiles, referenced);

  verifyScriptFilesAreReferenced(pluginId, packageDir, scriptFiles, referenced);

  const bridgeCalls = await verifyBridgeUsage(
    pluginId,
    packageDir,
    scriptFiles,
    declared,
    bridgeCapabilities,
  );

  return {
    bridgeCalls,
    files: htmlFiles.length + scriptFiles.length,
    pages: htmlFiles.length,
    pluginId,
    refs: refCount,
  };
}

/**
 * 校验清单里声明的窗口尺寸。
 *
 * 越界值宿主会静默夹取到边界，此时插件看起来「配了却没生效」——与其让人对着设置页
 * 排查，不如在提交前就把话说清楚。缺字段、宽高只写一维都不算错（那一维各自回落），
 * 因此这里只检查写出来的那些值。
 */
function verifyWindowPreference(pluginId, preference, limits) {
  if (preference === undefined) {
    return;
  }

  if (preference.kind !== undefined && !["standard", "quick"].includes(preference.kind)) {
    fail(pluginId, `清单的 window.kind 只能是 "standard" 或 "quick"，当前为「${preference.kind}」`);
  }

  if (typeof preference !== "object" || preference === null || Array.isArray(preference)) {
    fail(pluginId, "清单的 window 必须是形如 { \"width\": 720, \"height\": 680 } 的对象");
    return;
  }

  // 宿主建窗时对所有插件窗口（含 quick）统一套用 PLUGIN_WINDOW_MIN_SIZE，
  // 未对 quick 设独立下限；因此 quick 与普通窗口共用同一组边界，避免「清单写了更小值却
  // 被宿主夹回标准下限」这类静默不一致。上限也共用。
  for (const dimension of ["width", "height"]) {
    const value = preference[dimension];

    if (value === undefined) {
      continue;
    }

    if (typeof value !== "number" || !Number.isFinite(value)) {
      fail(pluginId, `清单的 window.${dimension} 必须是数字`);
      continue;
    }

    const min = limits[dimension].min;
    const max = limits[dimension].max;

    if (value < min || value > max) {
      fail(
        pluginId,
        `清单的 window.${dimension} 为 ${value}，超出宿主允许范围 ${min}-${max}（宿主会把它夹取到边界）`,
      );
    }
  }
}

/**
 * 读取清单。
 */
async function readManifest(pluginId, packageDir) {
  try {
    return JSON.parse(await readFile(join(packageDir, "plugin.json"), "utf8"));
  } catch (error) {
    fail(pluginId, `plugin.json 读取或解析失败：${error.message}`);

    return null;
  }
}

/**
 * 收集包内指定后缀的文件。
 */
async function collectFiles(packageDir, pattern) {
  const found = [];

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(directory, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (pattern.test(entry.name)) {
        found.push(fullPath);
      }
    }
  }

  await walk(packageDir);

  return found.sort();
}

/**
 * 校验 HTML 与 JS 里的包内引用，并把被引用到的文件记进 `referenced`。
 */
async function verifyReferences(pluginId, packageDir, htmlFiles, scriptFiles, referenced) {
  let checked = 0;

  for (const filePath of [...htmlFiles, ...scriptFiles]) {
    const isScript = /\.m?js$/i.test(filePath);
    const source = await readFile(filePath, "utf8");
    const fromFile = relative(packageDir, filePath).split(sep).join("/");

    for (const rawRef of extractReferences(pluginId, fromFile, source, isScript)) {
      if (rawRef.startsWith("/")) {
        fail(
          pluginId,
          `${fromFile} 里的引用「${rawRef}」以 / 开头：绝对路径会被解析到协议根而不是插件目录，包内引用必须写成相对路径`,
        );
        continue;
      }

      // 相对当前文件所在目录解析，再判断落点是否还在包内。
      const resolved = resolveInsidePackage(pluginId, `${dirname(fromFile)}/${rawRef}`);

      if (!resolved) {
        fail(pluginId, `${fromFile} 里的引用「${rawRef}」越出了插件包目录`);
        continue;
      }

      referenced.add(resolved.filePath);
      checked += 1;

      if (!existsSync(resolved.filePath)) {
        fail(pluginId, `${fromFile} 里的引用「${rawRef}」指向不存在的文件`);
      }
    }
  }

  return checked;
}

/**
 * 提取需要做存在性检查的引用。
 */
function extractReferences(pluginId, fromFile, source, isScript) {
  const pattern = isScript ? JS_REF_PATTERN : HTML_REF_PATTERN;
  const refs = [];

  for (const match of source.matchAll(pattern)) {
    // 去掉查询串与锚点：`./history.html#top` 要检查的是 `./history.html`。
    const raw = match[1].trim().split("#")[0].split("?")[0];

    if (raw === "" || raw.startsWith("#")) {
      continue;
    }

    if (SCHEME_PATTERN.test(raw)) {
      // `https://…`、`data:…` 这类带 scheme 的说明符交给 WebView 自己解析。
      continue;
    }

    if (!isScript && EXTERNAL_PREFIXES.some((prefix) => raw.startsWith(prefix))) {
      continue;
    }

    if (isScript && !raw.startsWith(".") && !raw.startsWith("/")) {
      fail(
        pluginId,
        `${fromFile} 里的模块引用「${raw}」是裸模块名：插件包没有打包器，也解析不了 node_modules，必须写成相对路径（./${raw}）`,
      );
      continue;
    }

    refs.push(raw);
  }

  return refs;
}

/**
 * 每个脚本文件都必须被某处引用到。
 *
 * 「文件写了但没人引入」是插件里最安静的一类 bug：页面照常打开、控制台没有任何报错，
 * 只是那段逻辑从来没运行过。
 */
function verifyScriptFilesAreReferenced(pluginId, packageDir, scriptFiles, referenced) {
  for (const filePath of scriptFiles) {
    if (!referenced.has(filePath)) {
      const name = relative(packageDir, filePath).split(sep).join("/");

      fail(pluginId, `${name} 没有被任何页面或模块引用，它不会被执行`);
    }
  }
}

/**
 * 校验能力桥的调用点。
 *
 * 插件调宿主能力必须既在桥的映射表里、又在清单里声明过。两处缺一都会静默失败：
 * 映射表里没有的名字是拼错了（`dasktop.net.request` 写成 `dasktop.net.get`），
 * 清单里没声明的权限会让桥根本不挂载那个命名空间。
 */
async function verifyBridgeUsage(pluginId, packageDir, scriptFiles, declared, bridgeCapabilities) {
  let checked = 0;

  for (const filePath of scriptFiles) {
    const source = await readFile(filePath, "utf8");
    const fromFile = relative(packageDir, filePath).split(sep).join("/");

    for (const match of source.matchAll(BRIDGE_CALL_PATTERN)) {
      const method = `${match[1]}.${match[2]}`;

      // 启动热键命名空间（`dasktop.hotkey`）是声明式宿主行为，不绑定任何能力权限，
      // 它不在 CAPABILITY_TABLE 里，因此跳过权限检查而只计入调用计数。
      if (match[1] === "hotkey") {
        checked += 1;
        continue;
      }

      const permission = bridgeCapabilities.get(method);

      checked += 1;

      if (!permission) {
        fail(
          pluginId,
          `${fromFile} 调用了 dasktop.${method}(...)，但能力桥没有这个方法（可用的方法：${[...bridgeCapabilities.keys()].join("、")}）`,
        );
        continue;
      }

      if (!declared.has(permission)) {
        fail(
          pluginId,
          `${fromFile} 用到了 dasktop.${method}(...)，需要能力 ${permission}，但 plugin.json 的 permissions 里没有声明`,
        );
      }
    }
  }

  return checked;
}

/**
 * 把包内相对路径解析成绝对路径；越出插件包时返回 null。
 */
function resolveInsidePackage(pluginId, relativePath) {
  const prefix = `/${pluginId}/`;
  let target;

  try {
    target = new URL(relativePath, `${PROTOCOL_ORIGIN}${prefix}`);
  } catch {
    return null;
  }

  if (!target.pathname.startsWith(prefix)) {
    return null;
  }

  let inner;
  try {
    inner = decodeURIComponent(target.pathname.slice(prefix.length));
  } catch {
    return null;
  }

  return { filePath: join(pluginsRoot, pluginId, inner), relativePath: inner };
}

/* -------------------------------------------------------------------------- */
/* 输出                                                                        */
/* -------------------------------------------------------------------------- */

function report() {
  console.log("插件包契约验证\n");

  for (const result of results) {
    console.log(
      `  ${result.pluginId.padEnd(18)} ${result.files} 个文件 · ${result.refs} 个包内引用 · ${result.bridgeCalls} 处能力调用`,
    );
  }

  console.log("");

  if (failures.length === 0) {
    console.log(`通过：${results.length} 个插件包`);
    return;
  }

  console.log(`发现 ${failures.length} 个问题：`);

  for (const failure of failures) {
    console.log(`  - ${failure.pluginId}：${failure.message}`);
  }

  process.exitCode = 1;
}
