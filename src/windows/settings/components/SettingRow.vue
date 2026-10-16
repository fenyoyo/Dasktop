<script setup lang="ts">
withDefaults(
  defineProps<{
    description?: string;
    /**
     * 是否显示底部分隔线由调用方根据列表顺序控制，避免最后一行出现多余边框。
     */
    divided?: boolean;
    gridClass?: string;
    title: string;
  }>(),
  {
    description: "",
    divided: true,
    gridClass: "grid-cols-[1fr_auto]",
  },
);
</script>

<template>
  <div class="grid min-h-[76px] items-center gap-6 px-5 py-3.5" :class="gridClass">
    <div class="flex min-w-0 items-center gap-3 pr-4">
      <!-- 行首附属物插槽：目前只放插件图标；未传入时不占空间，其它设置行外观不变。 -->
      <slot name="leading" />
      <div class="min-w-0 flex-1">
        <h2 class="text-[13px] font-semibold text-[#202229] dark:text-[#f4f4f5]">{{ title }}</h2>
        <p v-if="description" class="mt-1 text-[12px] leading-5 text-[#707684] dark:text-[#9ca0aa]">
          {{ description }}
        </p>
        <slot name="description" />
      </div>
    </div>

    <slot />
  </div>
  <div v-if="divided" class="h-px bg-[#e7e9ee] dark:bg-[#292c34]" />
</template>
