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
    <div class="min-w-0 pr-4">
      <h2 class="text-[13px] font-semibold text-[#202229] dark:text-[#f4f4f5]">{{ title }}</h2>
      <p v-if="description" class="mt-1 text-[12px] leading-5 text-[#707684] dark:text-[#9ca0aa]">
        {{ description }}
      </p>
      <slot name="description" />
    </div>

    <slot />
  </div>
  <div v-if="divided" class="h-px bg-[#e7e9ee] dark:bg-[#292c34]" />
</template>
