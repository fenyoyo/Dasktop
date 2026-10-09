<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { PluginUiNode } from "@/entities/pluginPackage";
import {
  emitPluginHostReady,
  emitPluginUiEvent,
  listenPluginHostSwitch,
  listenPluginUiRender,
} from "@/shared/ipc/pluginPackage";
import UiNodeRenderer from "./components/UiNodeRenderer.vue";

/**
 * 插件宿主窗口。
 *
 * 它只做两件事：渲染插件下发的界面描述树、把用户交互回传出去。本窗口里没有插件运行时，
 * 也拿不到任何宿主能力——插件代码始终跑在设置窗口的 Worker 中，两个窗口之间只通过事件通信。
 */
const props = defineProps<{ pluginId: string }>();

/** 当前展示的插件 id：首次来自 URL query，切换来自事件。 */
const currentPluginId = ref(props.pluginId);

/** 已收到的界面树。 */
const tree = ref<PluginUiNode | null>(null);

const unlisteners: UnlistenFn[] = [];

let isDisposed = false;

/**
 * 系统深浅色查询。
 *
 * 刻意不初始化桌面 Store：那会连带扫描桌面目录，为一个界面窗口付这个代价不值得。
 * 代价是与用户在设置里显式选择的主题可能不一致——系统主题通常与之一致。
 */
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");

/** 按系统偏好切换深浅色。 */
function applySystemTheme(): void {
  document.documentElement.classList.toggle("dark", systemTheme.matches);
}

/** 把界面交互送出去；真正到达插件需要绕经事件通道（见 PLUGIN_UI_EVENT 的注释）。 */
function handleAction(action: string, payload?: unknown): void {
  void emitPluginUiEvent({ action, payload, pluginId: currentPluginId.value });
}

onMounted(async () => {
  applySystemTheme();
  systemTheme.addEventListener("change", applySystemTheme);

  const handlers = await Promise.all([
    listenPluginUiRender((event) => {
      if (event.payload.pluginId === currentPluginId.value) {
        tree.value = event.payload.tree;
      }
    }),
    listenPluginHostSwitch((event) => {
      const nextPluginId = event.payload;

      if (typeof nextPluginId !== "string" || nextPluginId.length === 0) {
        return;
      }

      currentPluginId.value = nextPluginId;
      // 先清空再报到：避免切换瞬间仍显示上一个插件的界面。
      tree.value = null;
      void emitPluginHostReady(nextPluginId);
    }),
  ]);

  // 注册过程是异步的，期间窗口可能已被关闭，此时必须立即退订而不是把句柄存进已废弃的数组。
  if (isDisposed) {
    for (const unlisten of handlers) {
      unlisten();
    }

    return;
  }

  unlisteners.push(...handlers);

  // 主动报到：让插件运行时所在窗口补发当前界面树。新窗口无法靠「创建后补发事件」拿到树，
  // 因为事件可能早于本窗口的监听器注册。
  void emitPluginHostReady(currentPluginId.value);
});

onUnmounted(() => {
  isDisposed = true;
  systemTheme.removeEventListener("change", applySystemTheme);

  for (const unlisten of unlisteners) {
    unlisten();
  }

  unlisteners.length = 0;
});
</script>

<template>
  <main class="flex h-full w-full flex-col bg-[#f6f8fc] dark:bg-[#16181d]">
    <header
      class="flex shrink-0 items-center justify-between gap-3 border-b border-[#e7e9ee] px-4 py-3 dark:border-[#292c34]"
    >
      <h1 class="text-sm font-semibold text-[#0f172a] dark:text-[#e6e8ee]">插件界面</h1>
      <span class="truncate text-xs text-[#9aa3b2]">{{ currentPluginId }}</span>
    </header>

    <div class="dasktop-scrollarea flex-1 overflow-auto p-4">
      <UiNodeRenderer v-if="tree" :node="tree" @action="handleAction" />

      <div v-else class="flex flex-col gap-2 text-sm leading-6 text-[#6b7280] dark:text-[#9aa3b2]">
        <p>该插件尚未下发界面。</p>
        <p>
          插件可在 <code class="rounded bg-black/5 px-1 dark:bg-white/10">activate(host)</code>
          中调用
          <code class="rounded bg-black/5 px-1 dark:bg-white/10">host.ui.render(tree)</code>
          提供内容，并在清单里声明
          <code class="rounded bg-black/5 px-1 dark:bg-white/10">ui:panel</code> 权限。
        </p>
      </div>
    </div>
  </main>
</template>
