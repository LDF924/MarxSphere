// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
/**
 * `renderMarkdownLines` 的图片分支契约。
 *
 * 由来(2026-09-18): 这里原来**根本没有图片分支** —— `![图表](/api/viz/files/…)`
 * 会落到最后那条 `<p>`, 原样显示一坨 markdown 文本。而编辑器「插入正文」插的正是这个形状,
 * 所以"插入了图表"在预览里看不到图。
 *
 * 为什么用单测而不是浏览器探针: 这条链的**主要消费者 `EditorView.tsx` 是零 import 的死文件**,
 * 活着的消费者只有 `ChatPanel`; 要端到端驱动它得造会话+走 LLM 或精确复刻租户过滤,
 * 成本远高于收益。渲染器本身是纯函数, 单测能精确锁住"图 vs 文本"这个分叉。
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdownLines } from "./markdown";

// 组件走 useAuthedImage → 需要 localStorage / URL.createObjectURL
vi.stubGlobal("localStorage", { getItem: () => "tok", setItem: () => {}, removeItem: () => {} });
vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(["x"]) })));

const html = (md: string) => renderToStaticMarkup(<>{renderMarkdownLines(md)}</>);

describe("renderMarkdownLines 的图片", () => {
  it("独占一行的相对路径图片 → 交给带鉴权的组件(不是裸 img)", () => {
    const out = html("![图表](/api/viz/files/a.png)");
    // 未加载完时是占位(span[role=img]), 关键是不能原样吐出 markdown 文本
    expect(out).not.toContain("![图表]");
    expect(out).toMatch(/role="img"/);
  });

  it("外链图片 → 保持原生 <img>(不需要我们的 token, 不该被 fetch 成 blob)", () => {
    const out = html("![x](https://example.com/a.png)");
    expect(out).toContain('src="https://example.com/a.png"');
  });

  it("没图片的普通段落不受影响", () => {
    const out = html("这是一段普通正文。");
    expect(out).toContain("这是一段普通正文");
    expect(out).not.toContain("role=\"img\"");
  });

  it("行内图片(与文字混排)不走这条分支 —— 保持既有行为", () => {
    const out = html("前文 ![a](/api/viz/files/a.png) 后文");
    // 这条分支只认"独占一行"; 混排的交给行内渲染器, 这里只断言不崩、且不误判成块级图
    expect(out).toContain("前文");
    expect(out).toContain("后文");
  });
});
