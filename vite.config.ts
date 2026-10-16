import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error Tauri dev server 会通过 Node 环境变量注入局域网调试地址
const host = process.env.TAURI_DEV_HOST;
const srcAliasPath = new URL("./src", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const mainEntryPath = new URL("./index.html", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
// 屏幕框选覆盖页：宿主按相对路径 `capture-overlay.html` 建窗加载它，因此它必须与主入口
// 一起输出到产物根目录，不能被折叠进主入口的依赖图里。
const captureOverlayEntryPath = new URL("./capture-overlay.html", import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  "$1",
);

export default defineConfig(async () => ({
  plugins: [vue(), tailwindcss()],

  resolve: {
    // 跨窗口与领域模块统一使用 @/ 前缀，避免目录重构后深层相对路径继续扩散
    alias: {
      "@": srcAliasPath,
    },
  },

  build: {
    // 多入口：宿主主界面与屏幕框选覆盖页都要产出到 dist 根目录。
    // 覆盖页由 Rust 侧按固定相对路径建窗加载，若只声明主入口，它会被当成主入口的
    // 惰性依赖而不单独产出 HTML，导致运行时 404。
    rollupOptions: {
      input: {
        main: mainEntryPath,
        "capture-overlay": captureOverlayEntryPath,
      },
    },
  },

  // 保留 Rust 错误输出，避免前端 dev server 清屏后吞掉 Tauri 侧诊断信息
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // Rust 目标目录变动很频繁，忽略它可以减少无意义的前端热更新
      ignored: ["**/src-tauri/**"],
    },
  },
}));
