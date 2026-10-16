<script setup lang="ts">
import { computed, ref } from "vue";
import { Check, Pencil, X } from "@lucide/vue";
import {
  APP_SETTING_NUMBER_LIMITS,
  DEFAULT_APP_SETTINGS,
  type AppSettingBooleanKey,
} from "@/entities/appSettings/defaults";
import { WINDOW_BEHAVIOR_SETTING_CONTROLS } from "@/entities/appSettings/groups";
import type {
  AppSettings,
  ForegroundPinHotkeyRegistration,
  ForegroundPinHotkeyStatus,
} from "@/entities/appSettings/types";
import SettingGroup from "../components/SettingGroup.vue";
import SettingRow from "../components/SettingRow.vue";
import SettingSection from "../components/SettingSection.vue";
import SettingSlider from "../components/SettingSlider.vue";
import SettingSwitch from "../components/SettingSwitch.vue";
import { useHotkeyCapture } from "../composables/useHotkeyCapture";

const props = defineProps<{
  /**
   * 开机自启状态来自系统启动项，和 SQLite 中的渲染偏好分开维护。
   */
  autostartEnabled: boolean;
  /**
   * 「置顶当前前台窗口」全局快捷键的配置与状态。
   *
   * 首次读取完成前为 `null`：配置由 Rust 命令独占读写，设置页只能等命令返回，
   * 这段空隙渲染成「还没读到」而不是先塞一个默认值，避免闪现错误的键位。
   */
  foregroundPinHotkey: ForegroundPinHotkeyRegistration | null;
  /** 读取或保存该快捷键失败的原因，非空时在分组下方红字提示。 */
  foregroundPinHotkeyError: string;
  panelWidth: string;
  settings: AppSettings;
}>();

const emit = defineEmits<{
  autostartEnabledChange: [value: boolean];
  boxBooleanSettingChange: [key: AppSettingBooleanKey, value: boolean];
  foregroundPinHotkeySave: [accelerator: string, enabled: boolean];
  snapThresholdChange: [value: number];
  snapToEdgesChange: [value: boolean];
}>();

const SNAP_THRESHOLD_INPUT = {
  ...APP_SETTING_NUMBER_LIMITS.snapThreshold,
} as const;

/**
 * 编辑态里的图标按钮保持 32px 稳定尺寸，切换编辑态时不会挤动相邻输入框。
 */
const ICON_BUTTON_CLASS =
  "grid size-8 place-items-center rounded-[7px] text-[#68707d] transition-colors hover:bg-[#eef0f4] hover:text-[#17181c] dark:text-[#a7abb5] dark:hover:bg-[#242730] dark:hover:text-[#f4f4f5]";

/** 次要按钮与插件面板同款，保证两个面板的改键入口看起来是同一个控件。 */
const SECONDARY_BUTTON_CLASS =
  "inline-flex h-8 items-center gap-1.5 rounded-[7px] border border-[#dfe2e8] px-2.5 text-[12px] font-medium text-[#555b66] transition-colors hover:bg-[#f6f7fa] hover:text-[#17181c] dark:border-[#33363f] dark:text-[#a7abb5] dark:hover:bg-[#242730] dark:hover:text-[#f4f4f5]";

/**
 * 改键输入框：设置窗全局禁用了文本选中，这里要自己抢回 `select-text` 才能重填。
 */
const TEXT_INPUT_CLASS =
  "h-8 w-[120px] select-text rounded-[8px] border border-[#dfe2e8] bg-[#ffffff] px-2 text-center text-[13px] text-[#202229] outline-none transition-colors focus:border-[#9aa0ac] dark:border-[#33363f] dark:bg-[#202229] dark:text-[#f4f4f5]";

/**
 * 状态到文案的兜底：宿主下发的 `message` 更准（例如直接给出拒绝原因），缺失时才用它。
 */
const HOTKEY_STATUS_LABELS: Record<ForegroundPinHotkeyStatus, string> = {
  ok: "",
  systemReserved: "系统保留组合，无法注册",
  invalid: "快捷键格式不合法",
  disabled: "已禁用",
};

/** 是否处于改键捕获态；同时只会有一处编辑，因此不需要按行记录。 */
const editingHotkey = ref(false);

/** 改键草稿，进入编辑态时用当前生效值填充。 */
const draftAccelerator = ref("");

/**
 * 组合键捕获复用插件面板抽出的公共 composable：捕获方式（读物理键位、忽略裸修饰键）
 * 两类热键完全一致，差异只在「取到之后写谁的草稿、提交到哪条配置」。
 */
const hotkeyCapture = useHotkeyCapture({
  onCancel: () => cancelHotkeyEditing(),
  onCapture: (accelerator) => {
    draftAccelerator.value = accelerator;
  },
  onCommit: () => commitHotkey(),
});

/**
 * 这一行是否为「需要用户处理的错误」。
 *
 * `disabled` 只作为中性说明展示：它覆盖「用户主动关掉」与「还没配过键」两种情况，
 * 都不是故障，用红字提示会让正常状态看起来像出错。
 */
const hotkeyStatusIsError = computed(() => {
  const status = props.foregroundPinHotkey?.status;
  return status === "systemReserved" || status === "invalid";
});

/** 需要展示的状态说明文案；状态为 `ok` 时为空串，不占位。 */
const hotkeyStatusText = computed(() => {
  const registration = props.foregroundPinHotkey;
  if (!registration || registration.status === "ok") {
    return "";
  }

  return registration.message || HOTKEY_STATUS_LABELS[registration.status];
});

function startEditingHotkey(): void {
  editingHotkey.value = true;
  draftAccelerator.value = props.foregroundPinHotkey?.accelerator ?? "";

  // 回退聚焦目标用固定 id：它能兜住极少数平台 window 级捕获拿不到物理键位的情况。
  hotkeyCapture.startCapture("foreground-pin-hotkey-input");
}

function cancelHotkeyEditing(): void {
  editingHotkey.value = false;
  hotkeyCapture.stopCapture();
}

/**
 * 提交改键：把草稿连同当前启用状态交给宿主命令，由它做权威校验与持久化。
 *
 * 前端不实现快捷键合法性规则：一旦这里也判一遍，迟早出现「设置页说能存、按下却没反应」
 * 这种两份规则分叉的问题。
 */
function commitHotkey(): void {
  const value = draftAccelerator.value.trim();
  const enabled = props.foregroundPinHotkey?.enabled ?? true;

  emit("foregroundPinHotkeySave", value, enabled);
  cancelHotkeyEditing();
}

/** 切换启用状态：开关即时保存，不需要先进入编辑态。 */
function toggleHotkeyEnabled(enabled: boolean): void {
  emit(
    "foregroundPinHotkeySave",
    props.foregroundPinHotkey?.accelerator ?? "",
    enabled,
  );
}

/**
 * 清除已配置的组合键，让这一项回到「未配置快捷键」。
 *
 * 只清组合键、不动启用开关：与插件热键一致，「禁用」和「清除」是两件事。
 */
function clearHotkey(): void {
  emit(
    "foregroundPinHotkeySave",
    "",
    props.foregroundPinHotkey?.enabled ?? true,
  );
}
</script>

<template>
  <SettingSection
    description="调整 Box 窗口拖动手感和应用启动行为"
    :panel-width="panelWidth"
    title="窗口启动"
  >
    <SettingGroup>
      <SettingRow
        title="边缘吸附"
        description="拖动 Box 靠近屏幕边缘或其他 Box 时自动贴齐"
      >
        <SettingSwitch
          ariaLabel="边缘吸附"
          :model-value="props.settings.snapToEdges"
          @change="emit('snapToEdgesChange', $event)"
        />
      </SettingRow>

      <SettingRow
        v-for="control in WINDOW_BEHAVIOR_SETTING_CONTROLS"
        :key="control.key"
        :description="control.description"
        :title="control.label"
      >
        <SettingSwitch
          :ariaLabel="control.label"
          :model-value="Boolean(props.settings[control.key])"
          @change="emit('boxBooleanSettingChange', control.key, $event)"
        />
      </SettingRow>

      <SettingRow
        title="吸附距离"
        description="数值越大，拖动时越容易贴齐边缘"
        grid-class="grid-cols-[1fr_300px]"
      >
        <SettingSlider
          :default-value="DEFAULT_APP_SETTINGS.snapThreshold"
          label="吸附距离"
          :max="SNAP_THRESHOLD_INPUT.max"
          :min="SNAP_THRESHOLD_INPUT.min"
          :model-value="props.settings.snapThreshold"
          :step="SNAP_THRESHOLD_INPUT.step"
          :unit="SNAP_THRESHOLD_INPUT.unit"
          @change="emit('snapThresholdChange', $event)"
          @reset="
            emit('snapThresholdChange', DEFAULT_APP_SETTINGS.snapThreshold)
          "
        />
      </SettingRow>

      <SettingRow
        title="开机自启"
        description="登录 Windows 后自动启动 Dasktop，并恢复 Box 窗口"
        :divided="false"
      >
        <SettingSwitch
          ariaLabel="开机自启"
          :model-value="props.autostartEnabled"
          @change="emit('autostartEnabledChange', $event)"
        />
      </SettingRow>
    </SettingGroup>

    <SettingGroup class="mt-4">
      <SettingRow
        :divided="false"
        grid-class="grid-cols-[minmax(0,1fr)_auto]"
        title="置顶当前前台窗口"
      >
        <template #description>
          <p
            class="mt-1 text-[12px] leading-5 text-[#707684] dark:text-[#9ca0aa]"
          >
            按一次把系统当前激活的窗口固定在最上层，再按一次取消置顶；对任意应用生效
          </p>
          <p
            v-if="hotkeyStatusText"
            class="mt-1.5 text-[12px] leading-5"
            :class="
              hotkeyStatusIsError
                ? 'text-[#b52a2a] dark:text-[#ff9c9c]'
                : 'text-[#707684] dark:text-[#9ca0aa]'
            "
          >
            {{ hotkeyStatusText }}
          </p>
        </template>

        <div v-if="props.foregroundPinHotkey" class="flex items-center gap-2">
          <template v-if="editingHotkey">
            <input
              id="foreground-pin-hotkey-input"
              :value="draftAccelerator"
              aria-label="置顶快捷键"
              :class="TEXT_INPUT_CLASS"
              placeholder="按下组合键…"
              readonly
              type="text"
              @keydown="hotkeyCapture.handleKeydown"
            />
            <span
              class="text-[11px] leading-5 text-[#9aa0ac] dark:text-[#7c828d]"
            >
              按下要绑定的组合键
            </span>
            <button
              :class="ICON_BUTTON_CLASS"
              title="保存快捷键"
              type="button"
              @click="commitHotkey"
            >
              <Check :size="15" />
            </button>
            <button
              :class="ICON_BUTTON_CLASS"
              title="放弃修改"
              type="button"
              @click="cancelHotkeyEditing"
            >
              <X :size="15" />
            </button>
          </template>

          <template v-else>
            <span
              class="text-[13px] leading-5 text-[#202229] dark:text-[#f4f4f5]"
            >
              {{ props.foregroundPinHotkey.accelerator || "未配置" }}
            </span>
            <button
              :class="SECONDARY_BUTTON_CLASS"
              title="修改这条快捷键"
              type="button"
              @click="startEditingHotkey"
            >
              <Pencil :size="13" />
              改键
            </button>
            <button
              v-if="props.foregroundPinHotkey.accelerator"
              :class="SECONDARY_BUTTON_CLASS"
              title="清除这条快捷键"
              type="button"
              @click="clearHotkey"
            >
              <X :size="13" />
              清除
            </button>
          </template>

          <SettingSwitch
            ariaLabel="启用置顶快捷键"
            :model-value="props.foregroundPinHotkey.enabled"
            @change="toggleHotkeyEnabled"
          />
        </div>
      </SettingRow>
    </SettingGroup>

    <div
      v-if="props.foregroundPinHotkeyError"
      class="mt-4 rounded-[8px] border border-[#f0c7c7] bg-[#fff6f6] px-4 py-3 text-[13px] text-[#9f1d1d] dark:border-[#5b2a2d] dark:bg-[#281619] dark:text-[#ffb4b4]"
    >
      置顶快捷键保存失败：{{ props.foregroundPinHotkeyError }}
    </div>
  </SettingSection>
</template>
