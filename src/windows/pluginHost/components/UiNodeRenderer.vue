<script setup lang="ts">
import { computed } from "vue";
import type { PluginUiNode } from "@/entities/pluginPackage";

/**
 * 声明式界面节点渲染器。
 *
 * 这个组件是**插件唯一能影响宿主界面的途径**：它只认识协议里列出的节点类型，
 * 插件无法通过构造特殊节点把任意 HTML、内联样式或事件属性送进宿主页面。
 * 这是「声明式 UI」相对「插件直接操作 DOM」的核心收益。
 */
defineOptions({ name: "UiNodeRenderer" });

const props = defineProps<{ node: PluginUiNode }>();

const emit = defineEmits<{ (event: "action", action: string, payload?: unknown): void }>();

/** 文本视觉强度。 */
const TEXT_CLASSES: Record<string, string> = {
  muted: "text-[#6b7280] dark:text-[#9aa3b2]",
  normal: "text-[#0f172a] dark:text-[#e6e8ee]",
  strong: "font-semibold text-[#0f172a] dark:text-[#e6e8ee]",
};

/** 按钮视觉风格。 */
const BUTTON_CLASSES: Record<string, string> = {
  danger:
    "border-transparent bg-[#dc2626] text-white hover:bg-[#b91c1c] focus-visible:outline-[#dc2626]",
  default:
    "border-[#d7dae1] bg-white text-[#0f172a] hover:bg-[#f2f4f8] dark:border-[#33363f] dark:bg-[#22252c] dark:text-[#e6e8ee] dark:hover:bg-[#2a2e36]",
  primary: "border-transparent bg-[#2f6bff] text-white hover:bg-[#2559db]",
};

/** 容器间距档位。 */
const GAP_CLASSES: Record<string, string> = {
  lg: "gap-4",
  md: "gap-2",
  none: "gap-0",
  sm: "gap-1",
};

const buttonClass = computed(() => {
  if (props.node.type !== "button") {
    return "";
  }

  return [
    "rounded-md border px-3 py-1.5 text-sm transition-colors",
    BUTTON_CLASSES[props.node.tone ?? "default"] ?? BUTTON_CLASSES.default,
  ].join(" ");
});

const gapClass = computed(() => {
  if (props.node.type !== "stack") {
    return "";
  }

  return GAP_CLASSES[props.node.gap ?? "md"] ?? GAP_CLASSES.md;
});

const directionClass = computed(() => {
  if (props.node.type !== "stack") {
    return "";
  }

  return props.node.direction === "row" ? "flex-row items-center" : "flex-col";
});

const textClass = computed(() => {
  if (props.node.type !== "text") {
    return "";
  }

  return TEXT_CLASSES[props.node.tone ?? "normal"] ?? TEXT_CLASSES.normal;
});

/** 把子节点的交互原样向上冒泡，最终由窗口统一回传给插件。 */
function handleAction(action: string, payload?: unknown): void {
  emit("action", action, payload);
}

/** 输入框只在提交时回传，避免逐键往返导致整棵树重渲染、光标丢失。 */
function handleInputCommit(action: string, event: Event): void {
  const target = event.target;

  if (target instanceof HTMLInputElement) {
    handleAction(action, target.value);
  }
}
</script>

<template>
  <span v-if="node.type === 'text'" :class="textClass">{{ node.value }}</span>

  <button
    v-else-if="node.type === 'button'"
    type="button"
    :class="buttonClass"
    @click="handleAction(node.action)"
  >
    {{ node.label }}
  </button>

  <label v-else-if="node.type === 'input'" class="flex flex-col gap-1">
    <span v-if="node.label" class="text-xs text-[#6b7280] dark:text-[#9aa3b2]">
      {{ node.label }}
    </span>
    <input
      type="text"
      :default-value="node.value"
      :placeholder="node.placeholder"
      class="rounded-md border border-[#d7dae1] bg-white px-2 py-1.5 text-sm text-[#0f172a] placeholder:text-[#9aa3b2] dark:border-[#33363f] dark:bg-[#22252c] dark:text-[#e6e8ee]"
      @change="handleInputCommit(node.action, $event)"
      @keydown.enter="handleInputCommit(node.action, $event)"
    />
  </label>

  <div v-else-if="node.type === 'stack'" class="flex" :class="[directionClass, gapClass]">
    <UiNodeRenderer
      v-for="(child, index) in node.children"
      :key="index"
      :node="child"
      @action="handleAction"
    />
  </div>

  <section
    v-else-if="node.type === 'card'"
    class="rounded-lg border border-[#e7e9ee] bg-white p-4 dark:border-[#292c34] dark:bg-[#1e2128]"
  >
    <h3
      v-if="node.title"
      class="mb-3 text-sm font-semibold text-[#0f172a] dark:text-[#e6e8ee]"
    >
      {{ node.title }}
    </h3>
    <div class="flex flex-col gap-2">
      <UiNodeRenderer
        v-for="(child, index) in node.children"
        :key="index"
        :node="child"
        @action="handleAction"
      />
    </div>
  </section>

  <ul
    v-else-if="node.type === 'list'"
    class="flex flex-col gap-1 text-sm text-[#0f172a] dark:text-[#e6e8ee]"
  >
    <li v-for="(item, index) in node.items" :key="index" class="flex gap-2">
      <span class="text-[#9aa3b2]">·</span>
      <span class="break-all">{{ item }}</span>
    </li>
  </ul>

  <dl v-else-if="node.type === 'key-value'" class="flex flex-col gap-1 text-sm">
    <div
      v-for="(entry, index) in node.entries"
      :key="index"
      class="flex gap-3 border-b border-[#eef0f4] pb-1 last:border-b-0 dark:border-[#292c34]"
    >
      <dt class="min-w-[88px] shrink-0 text-[#6b7280] dark:text-[#9aa3b2]">{{ entry.key }}</dt>
      <dd class="break-all text-[#0f172a] dark:text-[#e6e8ee]">{{ entry.value }}</dd>
    </div>
  </dl>
</template>
