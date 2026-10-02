// file-preview.test.ts — 文件预览链路的不变量(2026-10-02)
//
// 为什么要有这个文件: 预览功能横跨**四处**, 任一处漏了都表现为
// "功能做了但用户够不着", 而且**不报错**:
//   ① 后端 file-text-service / office-preview-service 解析器
//   ② 后端 vault-service 的 BINARY_EXTENSIONS(目录树白名单)
//   ③ 后端 /api/preview/parse 的分派
//   ④ 前端 web/src/lib/file-kind.ts 的类型判断
// 实测踩过: 我给前端加了 drawio/geojson/csv 预览器, 却忘了 ② ——
//   那三种文件在资料库树里**根本不显示**, 界面上什么异常都没有。
//   (与"kind 静默降级"同型。) 所以这里锁的是**两层之间的对齐**, 不是单个函数。
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { readDrawio } from "../src/services/office-preview-service.js";

/**
 * 前端认得的扩展名 ⊂ 后端资料库树会列出的扩展名。
 *
 * 这条锁的是一个**跨文件的两层契约**(前端 lib/file-kind.ts 与后端 vault-service.ts)。
 * 实测踩过: 给前端加了 drawio/geojson/csv 的预览器, 后端白名单没跟上 ——
 * 那三种文件在资料库树里根本不出现, 用户看不到, 也没有任何报错。
 *
 * 用源码文本比对(而不是 import 前端模块): 前端是 TSX/浏览器环境, 这里只关心
 * **两个集合的字面量是否同步**, 读源码足够且不引入构建耦合。
 */
describe("预览白名单跨层对齐", () => {
  const root = path.resolve(__dirname, "..");

  /** 从一个文件里把 `.xxx` 形式的扩展名字面量全捞出来(仅限指定的那段) */
  function extsIn(relPath: string, from: string, to: string): Set<string> {
    const src = fs.readFileSync(path.join(root, relPath), "utf-8");
    const start = src.indexOf(from);
    const end = src.indexOf(to, start);
    expect(start, `${relPath} 找不到锚点「${from}」`).toBeGreaterThanOrEqual(0);
    const slice = src.slice(start, end > start ? end : undefined);
    return new Set([...slice.matchAll(/"\.([a-z0-9]+)"/g)].map((m) => m[1]));
  }

  it("前端 file-kind 认得的类型, 后端资料库树都列得出来", () => {
    const frontend = extsIn("web/src/lib/file-kind.ts", "const KIND_BY_EXT", "};");
    const backend = extsIn("src/services/vault-service.ts", "const BINARY_EXTENSIONS", "]);");
    // markdown 在前端表里, 后端由 MARKDOWN_EXTENSIONS 单独管 —— 这里只比 BINARY 那份
    const missing = [...frontend].filter((e) => !backend.has(e) && e !== "md" && e !== "markdown");
    expect(missing, `这些扩展名前端能预览但后端不列出(用户看不到文件): ${missing.join(", ")}`).toEqual([]);
  });
});

describe("drawio 解析", () => {
  const MX = `<mxGraphModel pageWidth="850" pageHeight="1100"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="a" value="起点 &amp; 出发" style="rounded=1" vertex="1"><mxGeometry x="40" y="80" width="120" height="60" as="geometry"/></mxCell>
    <mxCell id="b" value="终点" vertex="1"><mxGeometry x="300" y="80" width="120" height="60" as="geometry"/></mxCell>
    <mxCell id="e1" value="推动" style="endArrow=classic;" edge="1" source="a" target="b"><mxGeometry relative="1" as="geometry"/></mxCell>
  </root></mxGraphModel>`;

  it("节点与边分开, 坐标来自各自的 mxGeometry", () => {
    const r = readDrawio(MX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const nodes = r.shapes.filter((s) => !s.isEdge);
    const edges = r.shapes.filter((s) => s.isEdge);
    expect(nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(edges.map((e) => e.id)).toEqual(["e1"]);
    expect(nodes[0]).toMatchObject({ x: 40, y: 80, w: 120, h: 60 });
    // 边的几何是相对偏移, 画布上用不上 —— 必须是 0, 由 source/target 定位置
    expect(edges[0]).toMatchObject({ x: 0, y: 0, w: 0, h: 0, source: "a", target: "b" });
    expect(r.pageWidth).toBe(850);
  });

  it("XML 实体被解码(不显示成 &amp;)", () => {
    const r = readDrawio(MX);
    if (!r.ok) throw new Error("解析失败");
    expect(r.shapes.find((s) => s.id === "a")?.text).toBe("起点 & 出发");
  });

  it("相邻节点的 geometry 不串味", () => {
    // A 没有 geometry, B 有 —— A 绝不能拿到 B 的坐标。
    // 这条锁的是"从 m.index 往后 N 字符找 geometry"那种写法(它会把 B 的坐标给 A)。
    const r = readDrawio(`<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="A" value="无坐标" vertex="1"/>
      <mxCell id="B" value="有坐标" vertex="1"><mxGeometry x="999" y="888" width="7" height="6" as="geometry"/></mxCell></root></mxGraphModel>`);
    if (!r.ok) throw new Error("解析失败");
    expect(r.shapes.find((s) => s.id === "A")).toMatchObject({ x: 0, y: 0, w: 0, h: 0 });
    expect(r.shapes.find((s) => s.id === "B")).toMatchObject({ x: 999, y: 888 });
  });

  it("压缩格式(base64+deflateRaw)能解开 —— 那是 drawio 默认保存格式", () => {
    // 用 node:zlib 自己造一份, 不依赖 drawio 客户端
    const { deflateRawSync } = require("node:zlib") as typeof import("node:zlib");
    const inner = `<mxGraphModel pageWidth="850" pageHeight="1100"><root><mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="z" value="压缩页里的节点" vertex="1"><mxGeometry x="10" y="20" width="80" height="40" as="geometry"/></mxCell></root></mxGraphModel>`;
    const payload = deflateRawSync(Buffer.from(encodeURIComponent(inner), "utf-8")).toString("base64");
    const r = readDrawio(`<mxfile><diagram name="Page-1">${payload}</diagram></mxfile>`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.compressed).toBe(true);
    expect(r.shapes.map((s) => s.text)).toEqual(["压缩页里的节点"]);
  });

  it("不是 drawio 的内容 → 明确失败, 不假装成功", () => {
    const r = readDrawio("<html><body>这不是图</body></html>");
    expect(r.ok).toBe(false);
  });
});
