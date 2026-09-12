<script setup lang="ts">
/**
 * AgentFlowNode — 还原自闭源 QuickModeView-DJU6Ms4b.js AgentFlowNode(L13403-13522, data-v-be4e6308)
 * vue-flow 自定义节点: 190×190 卡片, 7 段信息(index/module/menu/title/progress/meta/footer + hint/detail/preview)
 * Handle: 连线柄(闭源 hasTarget/hasSource; 缺柄 = 无法拖线)
 */
import { Handle, Position } from "@vue-flow/core";
defineProps<{
  id: string;
  data: {
    index?: string;
    module?: string;
    title?: string;
    state?: string; // draft/queued/running/paused/completed/failed/cancelled/blocked
    stateLabel?: string;
    input?: string;
    output?: string;
    progress?: number;
    artifactCount?: number;
    layout?: string;
    locked?: boolean;
    systemStart?: boolean;
    hint?: string;
    executionDetail?: string;
    outputPreview?: string;
    hasTarget?: boolean;
    hasSource?: boolean;
  };
  selected?: boolean;
}>();
</script>

<template>
  <div
    class="agent-flow-node"
    :class="{
      'is-active': data.state === 'running',
      'is-done': data.state === 'completed',
      'is-error': data.state === 'failed',
      'is-locked': data.locked,
      'is-system-start': data.systemStart,
      'is-selected': selected
    }"
    role="button"
  >
    <!-- 连线柄(闭源 hasTarget/hasSource: target 顶/左, source 底/右) -->
    <Handle v-if="data.hasTarget !== false" type="target" :position="data.layout === 'horizontal' ? Position.Left : Position.Top" />
    <Handle v-if="data.hasSource !== false" type="source" :position="data.layout === 'horizontal' ? Position.Right : Position.Bottom" />
    <!-- header: index + module + menu -->
    <div class="node-header">
      <span class="node-index">{{ data.index }}</span>
      <span class="node-module">{{ data.module }}</span>
      <span class="node-menu">•••</span>
    </div>

    <!-- title -->
    <div class="node-title-row">
      <strong>{{ data.title }}</strong>
    </div>

    <!-- progress -->
    <div v-if="data.progress !== undefined && data.progress !== null" class="node-progress">
      <span class="node-progress-track"><i :style="{ width: Math.min(100, Math.max(0, Number(data.progress))) + '%' }"></i></span>
      <span>{{ Math.round(Number(data.progress)) }}%</span>
    </div>

    <!-- meta 输入输出 -->
    <div class="node-meta">
      <span>输入: {{ data.input || "待分配" }}</span>
    </div>
    <div class="node-meta">
      <span>输出: {{ data.output || data.stateLabel || "—" }}</span>
    </div>

    <!-- footer: state + artifacts -->
    <div class="node-footer">
      <span class="node-state">
        <span class="node-status-dot"></span>
        {{ data.stateLabel || data.state || "" }}
      </span>
      <span v-if="data.artifactCount" class="node-artifacts">□ {{ data.artifactCount }} 产物</span>
      <span class="node-arrow">→</span>
    </div>

    <!-- 条件块 -->
    <div v-if="data.hint" class="node-hint">{{ data.hint }}</div>
    <div v-if="data.executionDetail" class="node-execution-detail">{{ data.executionDetail }}</div>
    <div v-if="data.outputPreview" class="node-output-preview">{{ data.outputPreview }}</div>
  </div>
</template>

<style scoped>
.agent-flow-node {
  position: relative;
  box-sizing: border-box;
  width: 190px;
  min-height: 190px;
  max-height: 224px;
  overflow: hidden;
  padding: 11px 12px 10px;
  border: 1px solid #2A3A55;
  border-radius: 7px;
  background: #11192C;
  color: #E8EEF7;
  box-shadow: 0 6px 18px rgba(56, 76, 113, 0.08);
  cursor: grab;
  transition: border-color 0.16s, box-shadow 0.16s, transform 0.16s;
  font-family: PingFang SC, Microsoft YaHei, sans-serif;
}
.agent-flow-node.is-active { border-color: #7184f5; background: #fbfcff; }
.agent-flow-node.is-system-start { border-color: #56b9c0; background: #101A2B; box-shadow: 0 0 0 2px rgba(0, 167, 181, 0.12), 0 8px 20px rgba(56, 118, 130, 0.12); }
.agent-flow-node.is-locked { opacity: 0.92; }
.agent-flow-node.is-selected { border-color: #4D84CB; box-shadow: 0 0 0 3px rgba(99, 121, 237, 0.18), 0 6px 18px rgba(56, 76, 113, 0.12); }
.node-header, .node-footer, .node-meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.node-index { color: #73809b; font-size: 9px; font-weight: 750; letter-spacing: 0.1em; }
.node-module { color: #7e8da8; font-size: 8px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; }
.node-menu { color: #7A8AA0; font-size: 10px; letter-spacing: 0.12em; }
.node-title-row { display: flex; align-items: flex-start; gap: 7px; min-height: 34px; margin: 12px 0 10px; }
.node-title-row strong {
  display: -webkit-box;
  overflow: hidden;
  font-size: 12px;
  font-weight: 700;
  line-height: 1.45;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  word-break: break-all;
}
.node-progress { display: flex; align-items: center; gap: 7px; margin: 5px 0 6px; color: #8B9BB1; font-size: 9px; }
.node-progress-track { display: block; height: 4px; flex: 1; overflow: hidden; border-radius: 5px; background: #222F44; }
.node-progress-track i { display: block; height: 100%; border-radius: inherit; background: #4D84CB; transition: width 0.3s; }
.node-state { display: flex; align-items: center; gap: 5px; }
.node-status-dot { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: #bdc6d5; }
.is-active .node-status-dot { background: #647bf2; box-shadow: 0 0 0 3px rgba(100, 123, 242, 0.14); }
.is-done .node-status-dot { background: #5FD0B4; }
.is-error .node-status-dot { background: #d75e5e; }
.node-meta { padding: 4px 0; color: #7A8AA0; font-size: 9px; }
.node-meta span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.node-value { max-width: 108px; overflow: hidden; color: #66758c; text-overflow: ellipsis; white-space: nowrap; }
.node-footer { margin-top: 8px; padding-top: 8px; border-top: 1px solid #1A2333; color: #8B9BB1; font-size: 9px; }
.node-artifacts { margin-left: auto; }
.node-arrow { color: #7387ec; font-size: 13px; }
.node-hint { margin-top: 7px; color: #4D84CB; font-size: 9px; line-height: 1.4; }
.node-execution-detail { margin-top: 6px; color: #4D84CB; font-size: 9px; line-height: 1.35; }
.node-output-preview {
  max-height: 54px;
  margin-top: 6px;
  overflow: hidden;
  padding: 6px 7px;
  border-left: 2px solid #9aaaf0;
  background: #1A2438;
  color: #93A5BC;
  font-size: 9px;
  line-height: 1.45;
}
</style>
