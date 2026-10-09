#!/usr/bin/env node
/**
 * 插件包契约验证。
 *
 * 插件界面是插件包里的网页，完全不在 TypeScript 的覆盖范围内——`vue-tsc` 与
 * `vite build` 都不会看一眼 `plugins/` 目录。清单里文件名写错、页面里的相对链接指向
 * 不存在的文件、声明了宿主不认识的权限，这些问题构建阶段全都发现不了，要等用户打开
 * 插件窗口才暴露，而那时候他能看到的只是一片空白。
 *
 * 这个脚本把这几类检查提到提交前：
 *
 * 1. 清单可解析、id 与目录名一致、entry 非空且指向 HTML；
 * 2. 入口页面真实存在；
 * 3. 包内每个 HTML 里的相对引用都指向真实存在的文件，且没有逃出包目录；
 * 4. 清单声明的权限都在宿主已知集合内（集合从 `types.ts` 实时解析，不另抄一份）。
 *
 * 零依赖，直接 `node scripts/verify-plugins.mjs`，不需要先跑 `pnpm install`。
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginsRoot = join(repoRoot, "plugins");

/**
 * 与宿主扫描保持一致的目录跳过规则：`.` 与 `_` 开头的目录是留给宿主与作者自己的。
 */
const RESERVED_PREFIXES = "._";

/**
 * 从 HTML 里挑出 href / src 属性。不引 HTML 解析器：这里只需要属性值，
 * 一层正则足够，也避免为一个校验脚本引入依赖。
 */
const LINK_PATTERN = /(?:href|src)\s*=\s*["']([^"']*)["']/gi;

/**
 * 不需要做存在性检查的引用前缀。
 */
const EXTERNAL_PREFIXES = ["//", "data:", "http:", "https:", "javascript:", "mailto:", "tel:"];

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
  const pluginIds = await listPluginDirectories();

  for (const pluginId of pluginIds) {
    results.push(await verifyPackage(pluginId, knownPermissions));
  }

  report();
}

await main();

/**
 * 读取宿主认识的权限集合。
 */
async function loadKnownPermissions() {
  const source = await readFile(join(repoRoot, "src/entities/pluginPackage/types.ts"), "utf8");
  const block = source.match(/export const PLUGIN_PERMISSIONS = \[([\s\S]*?)\] as const;/);

  if (!block) {
    throw new Error("未能从 src/entities/pluginPackage/types.ts 解析出 PLUGIN_PERMISSIONS");
  }

  return new Set([...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]));
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

/**
 * 校验单个插件包。
 */
async function verifyPackage(pluginId, knownPermissions) {
  const packageDir = join(pluginsRoot, pluginId);
  const manifest = await readManifest(pluginId, packageDir);

  if (!manifest) {
    return { links: 0, pages: 0, pluginId };
  }

  if (manifest.id !== pluginId) {
    fail(pluginId, `清单 id「${manifest.id}」与目录名「${pluginId}」不一致`);
  }

  for (const permission of manifest.permissions ?? []) {
    if (!knownPermissions.has(permission)) {
      fail(pluginId, `声明了宿主不认识的能力：${permission}`);
    }
  }

  if (typeof manifest.entry !== "string" || manifest.entry.trim() === "") {
    fail(pluginId, "清单未声明 entry");

    return { links: 0, pages: 0, pluginId };
  }

  const entry = resolveInsidePackage(pluginId, manifest.entry);
  if (!entry) {
    fail(pluginId, `entry「${manifest.entry}」越出了插件包目录`);

    return { links: 0, pages: 0, pluginId };
  }

  if (!/\.html?$/i.test(manifest.entry)) {
    fail(pluginId, `entry「${manifest.entry}」不是 HTML 文件`);
  }

  if (!existsSync(entry.filePath)) {
    fail(pluginId, `entry「${manifest.entry}」不存在`);
  }

  const htmlFiles = await collectHtmlFiles(packageDir);
  const linkCount = await verifyPageLinks(pluginId, packageDir, htmlFiles);

  return { links: linkCount, pages: htmlFiles.length, pluginId };
}

/**
 * 读取并解析清单。
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
 * 收集包内全部 HTML 文件。
 */
async function collectHtmlFiles(packageDir) {
  const found = [];

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(directory, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (/\.html?$/i.test(entry.name)) {
        found.push(fullPath);
      }
    }
  }

  await walk(packageDir);

  return found.sort();
}

/**
 * 校验每个页面里的包内引用。
 */
async function verifyPageLinks(pluginId, packageDir, htmlFiles) {
  let checked = 0;

  for (const htmlPath of htmlFiles) {
    const html = await readFile(htmlPath, "utf8");
    const fromPage = relative(packageDir, htmlPath).split(sep).join("/");

    for (const rawLink of extractLocalLinks(html)) {
      if (rawLink.startsWith("/")) {
        fail(
          pluginId,
          `${fromPage} 里的引用「${rawLink}」以 / 开头：绝对路径会被解析到协议根而不是插件目录，包内引用必须写成相对路径`,
        );
        continue;
      }

      // 相对当前页面所在目录解析，再判断落点是否还在包内。
      const resolved = resolveInsidePackage(pluginId, `${dirname(fromPage)}/${rawLink}`);

      if (!resolved) {
        fail(pluginId, `${fromPage} 里的引用「${rawLink}」越出了插件包目录`);
        continue;
      }

      checked += 1;

      if (!existsSync(resolved.filePath)) {
        fail(pluginId, `${fromPage} 里的引用「${rawLink}」指向不存在的文件`);
      }
    }
  }

  return checked;
}

/**
 * 提取需要做存在性检查的引用。
 */
function extractLocalLinks(html) {
  const links = [];

  for (const match of html.matchAll(LINK_PATTERN)) {
    // 去掉查询串与锚点：`./history.html#top` 要检查的是 `./history.html`。
    const raw = match[1].trim().split("#")[0].split("?")[0];

    if (raw === "" || raw.startsWith("#")) {
      continue;
    }

    if (EXTERNAL_PREFIXES.some((prefix) => raw.startsWith(prefix))) {
      continue;
    }

    links.push(raw);
  }

  return links;
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

/**
 * 输出结果。
 */
function report() {
  console.log("插件包契约验证\n");

  for (const result of results) {
    console.log(
      `  ${result.pluginId.padEnd(18)} ${result.pages} 个页面 · ${result.links} 个包内引用`,
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
