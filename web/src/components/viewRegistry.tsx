// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// viewRegistry.tsx — 前端面板注册表（架构A3：面板插件化）
// 插件模式：现有 40 视图仍走 App.tsx 硬编码（不动、零回归）；
// 新能力面板通过 registerView() 注册 → App.tsx 渲染时先查注册表，
// 命中则渲染注册面板（含导航自动挂载），未命中回退硬编码。
// 新增面板 = 一行 registerView()，无需改动 App.tsx switch。
import type { ComponentType, ReactNode } from "react";

/** 视图注册项 */
export interface ViewEntry {
  value: string;
  label: string;
  labelEn: string;
  category: string;          // core | literature | knowledge | policy | skills | system
  component: ComponentType;
  dot?: string;              // 分类色点
  icon?: ReactNode;
  desc?: string;
}

/** 分类色点（供导航，与 App.tsx GROUP_DOTS 同体系） */
export const CATEGORY_DOTS: Record<string, string> = {
  core: "hsl(43 96% 60%)",
  literature: "hsl(150 45% 50%)",
  knowledge: "hsl(214 60% 55%)",
  policy: "hsl(28 70% 55%)",
  skills: "hsl(280 50% 60%)",
  system: "hsl(220 10% 55%)",
};

/** 插件面板注册表（A3：初始为空，registerView 追加） */
const registry = new Map<string, ViewEntry>();

/** 注册一个面板插件（新能力面板挂载入口） */
export function registerView(entry: ViewEntry): void {
  registry.set(entry.value, { ...entry, dot: entry.dot ?? CATEGORY_DOTS[entry.category] });
}

/** 批量注册 */
export function registerViews(entries: ViewEntry[]): void {
  entries.forEach(registerView);
}

/** 查询面板（App.tsx 渲染时先查此处；未命中回退硬编码 switch） */
export function getRegisteredView(value: string): ViewEntry | undefined {
  return registry.get(value);
}

/** 全部注册面板（供导航生成） */
export function listRegisteredViews(): ViewEntry[] {
  return [...registry.values()];
}
