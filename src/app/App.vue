<script setup lang="ts">
import DesktopWindow from "@/windows/desktop/index.vue";
import BoxContextMenuWindow from "@/windows/boxContextMenu/index.vue";
import DragPreviewWindow from "@/windows/dragPreview/index.vue";
import PluginHostWindow from "@/windows/pluginHost/index.vue";
import SettingsPage from "@/windows/settings/index.vue";

/**
 * 根路由只按查询参数区分设置窗、Box 窗、菜单窗和插件宿主窗，
 * Box 文件区统一由当前 WebView 渲染。
 */
const searchParams = new URLSearchParams(window.location.search);
const boxId = searchParams.get("boxId");
const pluginHostId = searchParams.get("pluginHost");
const isBoxMenu = searchParams.has("boxMenu");
const isDragPreview = searchParams.has("dragPreview");
</script>

<template>
  <BoxContextMenuWindow v-if="isBoxMenu" />
  <DragPreviewWindow v-else-if="isDragPreview" />
  <DesktopWindow v-else-if="boxId" :box-id="boxId" />
  <PluginHostWindow v-else-if="pluginHostId" :plugin-id="pluginHostId" />
  <SettingsPage v-else />
</template>
