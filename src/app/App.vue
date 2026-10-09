<script setup lang="ts">
import DesktopWindow from "@/windows/desktop/index.vue";
import BoxContextMenuWindow from "@/windows/boxContextMenu/index.vue";
import DragPreviewWindow from "@/windows/dragPreview/index.vue";
import SettingsPage from "@/windows/settings/index.vue";

/**
 * 根路由只按查询参数区分设置窗、Box 窗与菜单窗，
 * Box 文件区统一由当前 WebView 渲染。
 *
 * 插件窗口不在这里分支：它加载的是 `plugin` 协议下的插件页面，应用外壳整个不参与，
 * 也就没有任何一份需要在这里判断的查询参数。
 */
const searchParams = new URLSearchParams(window.location.search);
const boxId = searchParams.get("boxId");
const isBoxMenu = searchParams.has("boxMenu");
const isDragPreview = searchParams.has("dragPreview");
</script>

<template>
  <BoxContextMenuWindow v-if="isBoxMenu" />
  <DragPreviewWindow v-else-if="isDragPreview" />
  <DesktopWindow v-else-if="boxId" :box-id="boxId" />
  <SettingsPage v-else />
</template>
