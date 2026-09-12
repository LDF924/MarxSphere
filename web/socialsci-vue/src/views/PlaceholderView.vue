<script setup lang="ts">
import { useRoute } from "vue-router";
const route = useRoute();
</script>

<template>
  <div style="display: flex; flex-direction: column; height: 100vh; overflow: hidden; background: #0A1120; font-family: system-ui">
    <header style="display: flex; align-items: center; justify-content: space-between; padding: 10px 22px; background: #11192C; border-bottom: 1px solid #222F44; flex-shrink: 0">
      <div style="display: flex; align-items: center; gap: 11px">
        <div style="width: 32px; height: 32px; border-radius: 8px; display: grid; place-items: center; background: #4D84CB; color: #F1F5F9; font-weight: 800; font-size: 13px">研</div>
        <div>
          <div style="font-size: 15px; font-weight: 700; color: #E8EEF7">{{ (route.meta.title as string) || "科研工作台" }}</div>
          <div style="font-size: 10px; color: #8B9BB1; margin-top: 3px">MarxSphere 科研中心 · 完整功能视图</div>
        </div>
      </div>
      <div style="font-size: 11px; color: #8B9BB1">route: {{ route.path }}</div>
    </header>
    <main style="flex: 1; display: grid; place-items: center; color: #8B9BB1">
      <div style="text-align: center">
        <div style="font-size: 44px; margin-bottom: 10px">📦</div>
        <div style="font-size: 14px; font-weight: 600; color: #DCE6F2">模块建设中</div>
        <div style="font-size: 12px; margin-top: 6px">该视图正在完善, 请从科研中心入口选择已开放的功能。</div>
      </div>
    </main>
  </div>
</template>
