<script setup lang="ts">
/**
 * EmptyState —— 写作舱统一的空态。
 *
 * V422 由来(2026-09-21 用户反馈"前端太简陋"): 重构前全舱 14 处空态几乎都是
 * **一行灰字**(「暂无文献检索素材」「待分析完成后展示」), 既没有图示也没有"下一步做什么"。
 * 空态是用户**第一次**看到这个区域时的全部内容 —— 它不是在说"这里空", 而应该说
 * "这里将有什么、怎么让它出现"。
 *
 * 设计取舍:
 *   · **不用插画**。深色科研工具里大幅插画会喧宾夺主, 且要引入资源。用**一个线性图标 +
 *     一条下一步动作**就够, 信息密度也更符合工具型界面。
 *   · `hint` 是"将有什么/为什么重要", `action` 是"现在能做什么" —— 两者都给了才是引导,
 *     只给一个就退化成装饰或命令。
 *   · 三个尺寸: sm(卡内一小块) / md(整张卡) / lg(整页空态)。
 */
withDefaults(defineProps<{
  /** 图标(emoji 或单个字符, 保持轻量; 深色下 emoji 也够清晰) */
  icon?: string;
  /** 主文案: 这里是什么/为什么空 */
  title: string;
  /** 补充说明: 将有什么, 或为什么重要 */
  hint?: string;
  /** 操作按钮文案(给了才渲染按钮) */
  action?: string;
  /** 按钮是否禁用 */
  disabled?: boolean;
  size?: "sm" | "md" | "lg";
}>(), {
  icon: "○",
  size: "md",
  disabled: false,
});
defineEmits<{ (e: "action"): void }>();
</script>

<template>
  <div class="es" :class="`es--${size}`">
    <span class="es-icon" aria-hidden="true">{{ icon }}</span>
    <p class="es-title">{{ title }}</p>
    <p v-if="hint" class="es-hint">{{ hint }}</p>
    <button v-if="action" type="button" class="es-action" :disabled="disabled" @click="$emit('action')">
      {{ action }}
    </button>
    <!-- 允许调用方追加更复杂的操作组(如两个按钮、一个链接) -->
    <div v-if="$slots.extra" class="es-extra"><slot name="extra" /></div>
  </div>
</template>

<style scoped>
.es {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  text-align: center; color: var(--wf-muted);
  border-radius: var(--wf-r);
}
.es--sm { padding: 18px 12px; gap: 4px; }
.es--md { padding: 30px 20px; gap: 6px; }
.es--lg { padding: 48px 24px; gap: 8px; }
/* 图标用一个柔和的圆形底衬, 比裸 emoji 更像"这是有意留白的区域" */
.es-icon {
  width: 40px; height: 40px; border-radius: var(--wf-r-pill);
  display: grid; place-items: center; font-size: 19px; line-height: 1;
  background: var(--wf-raised); color: var(--wf-muted); margin-bottom: 4px;
}
.es--lg .es-icon { width: 52px; height: 52px; font-size: 24px; }
.es-title { margin: 0; font-size: var(--wf-f-md); font-weight: 600; color: var(--wf-text-2); }
.es-hint { margin: 0; font-size: var(--wf-f-sm); line-height: 1.65; color: var(--wf-faint); max-width: 46ch; }
.es-action {
  margin-top: 8px; padding: 7px 18px; border: 1px solid var(--wf-line-strong);
  border-radius: var(--wf-r-sm); background: var(--wf-raised); color: var(--wf-text-2);
  font-size: var(--wf-f-sm); cursor: pointer; transition: all .15s;
}
.es-action:hover:not(:disabled) { border-color: var(--wf-accent); color: var(--wf-text); background: var(--wf-accent-soft); }
.es-action:disabled { opacity: .5; cursor: not-allowed; }
.es-extra { margin-top: 6px; display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
</style>
