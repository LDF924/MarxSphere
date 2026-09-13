// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// src/views/quick/orchNodeActions.ts — V415: 画布 → 节点卡片 的操作回调契约
//
// 为什么单独一个文件: `<script setup>` 里不能写 ES 导出, 而画布组件与节点组件都要引用
// 这个 Symbol。另一个原因是它必须能在 .vue 之外被导入 —— 节点是 VueFlow 在**它自己内部**
// 渲染的, 节点 emit 的事件到不了画布上写的监听器(Vue 只向直接父组件投递),
// 所以改用 provide/inject 把回调递进去。
export const ORCH_NODE_ACTIONS = Symbol("orch-node-actions");

/** 节点卡片上的两个入口(••• 开菜单 / → 打开详情) */
export interface OrchNodeActions {
  menu: (ev: MouseEvent, node: { id: string; title?: string }) => void;
  open: (ev: MouseEvent, node: { id: string; title?: string }) => void;
}
