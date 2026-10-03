// web-read.test.ts — 网页正文抽取的不变量(2026-10-04)
//
// 这个抽取器是**从观澜/Guanlan 移植的代码**(MIT, 见 THIRD_PARTY_NOTICES.md 第 9 节),
// 对应其 `_extract_article_text` / `_drop_noise_blocks` / `_prefer_main_content` /
// `_extract_density_text` / `_is_noise_content_line` 等函数。
//
// 为什么要有这个文件: 它**失败起来是静默的** —— 不抛错, 只返回空串或一坨导航文字,
//   上游据此判"抓不到", 用户看到一句语焉不详的失败提示。移植过程中实测踩到的坑,
//   每一个都"看代码挺对":
//
//   ① **`\W` 语义不同**(最坑的一个)。原文 `re.fullmatch(r"[\W_]+", line)` 是排除"纯符号行";
//      直译成 `/^[\W_]+$/` 之后**所有中文行都被判成噪声** → 整篇抽出 **0 字**。
//      Python 3 的 `str` 正则 Unicode 感知(`\w` 含 CJK), 而 JS 的 `\w` 只有 `[A-Za-z0-9_]`。
//   ② **块级匹配顺序**。逐块 `<(div|p|…)>[\s\S]*?</div>` 会先吃到最外层 div 再把它整块丢掉,
//      里面的段落一起消失。原做法是先把块级标签**全局替换成换行**再剥标签。
//   ③ **标题在 head 里**, 而抽取前先剥了 head → 标题恒为空, 归档文件名退化成"未命名页面"。
import { describe, expect, it } from "vitest";
import { htmlToMarkdown, assessQuality } from "../src/services/web-read-service.js";

/** 仿中文新闻站的真实结构: 嵌套 div、面包屑与正文共用 content 字样、旁边一整块全是链接的推荐位 */
const NEWS_PAGE = `<html><head><title>测试新闻页</title>
<meta property="og:title" content="农业农村现代化进程中的工商资本规范研究" /></head><body>
<div class="fl content"><a href="/">首页</a> <span>&gt;</span> <a href="/news">新闻</a> <span>&gt;</span> 正文</div>
<div class="wrap"><div class="main-box"><div class="post_content">
<h1>农业农村现代化进程中的工商资本规范研究</h1>
<p>本文讨论工商资本进入农业农村领域后的规范与引导路径，重点关注资本下乡的双重效应。</p>
<p>研究发现，资本下乡在提升农业生产效率的同时，也可能带来土地流转的非粮化倾向，需要通过制度设计加以约束。</p>
<p>进一步的分析表明，村社集体的组织能力是决定资本下乡效果的关键变量，组织能力强的村庄更容易实现共赢。</p>
</div></div>
<div class="recommend-related"><h3>相关阅读</h3>
<a href="/a1">某地推进乡村振兴的十条经验</a><a href="/a2">工商资本进入农业的争议</a>
<a href="/a3">土地流转价格形成机制</a></div>
<div class="comment-box"><h3>全部评论</h3><p>登录后参与评论</p></div>
</div></body></html>`;

describe("网页正文抽取(观澜移植)", () => {
  it("中文正文不被当成噪声丢光(回归: `\\W` 直译导致抽出 0 字)", () => {
    const r = htmlToMarkdown(NEWS_PAGE);
    expect(
      r.markdown.length,
      "抽出 0 字 —— 先查 isNoiseContentLine 里是不是又写回了 /^[\\W_]+$/",
    ).toBeGreaterThan(80);
    expect(r.markdown).toContain("工商资本进入农业农村领域");
  });

  it("嵌套 div 不吃掉整篇(回归: 逐块匹配外层 div 会连带丢掉内层段落)", () => {
    expect(htmlToMarkdown(NEWS_PAGE).markdown).toContain("村社集体的组织能力");
  });

  it("导航与推荐位不混进正文", () => {
    const r = htmlToMarkdown(NEWS_PAGE);
    expect(r.markdown).not.toContain("相关阅读");
    expect(r.markdown).not.toContain("全部评论");
    expect(r.markdown).not.toMatch(/^首页$/m);
  });

  it("标题取得到(回归: 曾在剥离 head 之后才取, 恒为空)", () => {
    expect(htmlToMarkdown(NEWS_PAGE).title).toBe("农业农村现代化进程中的工商资本规范研究");
  });

  it("HTML 实体解码, 且 & 最后解(不双重解码)", () => {
    const r = htmlToMarkdown(`<html><head><title>t</title></head><body><article>
      <p>甲 &amp; 乙 成立公司, 这一段要有足够长度才不会被判成噪声行。</p>
      <p>字面量 &amp;lt; 不该变成尖括号, 同样要写够长度。</p></article></body></html>`);
    expect(r.markdown).toContain("甲 & 乙");
    expect(r.markdown).toContain("&lt;");
  });

  it("不规整页面走密度抽取(段落没被 content/article 类容器包住时也能拿到正文)", () => {
    const messy = `<html><head><title>m</title></head><body><div><div><div>
      <p>第一段足够长的中文正文内容, 用来确保密度抽取的判据能选中它而不是别的东西。</p>
      <p>第二段同样足够长, 讲的是同一件事的另一个侧面, 逗号、句号都要有。</p>
      <p>第三段补足长度, 让这一段文本的整体得分明显高于空白与导航。</p></div></div></div></body></html>`;
    expect(htmlToMarkdown(messy).markdown).toContain("第一段足够长的中文正文内容");
  });

  it("不是网页的内容 → 抽出极少文本, 由质量报告判 failed(而不是假装成功)", () => {
    const r = htmlToMarkdown("<html><body></body></html>");
    expect(assessQuality(r.markdown, r.noiseHits).label).toBe("failed");
  });
});

describe("阅读质量判据", () => {
  it("乱码会被识别出来", () => {
    expect(assessQuality("Ã¥Â¥Â½Ã§Å¡â€žæ–‡ç« ", []).mojibake).toBe(true);
  });

  it("极短内容判 failed(<120 字), 偏薄但不算空的判 thin(120-400 字)", () => {
    // 两档的界限就是"这算不算抽到了正文": 4 字连标题都不够, 只能算没抽到
    expect(assessQuality("太短了。", []).label).toBe("failed");
    const thin = Array.from({ length: 6 }, (_, i) => `第${i}段：这段中文长度中等，用来验证 120 到 400 字之间会被判成 thin。`).join("");
    expect(assessQuality(thin, []).label).toBe("thin");
  });

  it("干净的长正文判 clean 且给高分", () => {
    const body = Array.from({ length: 20 }, (_, i) => `第${i}段：这是一段正常的中文正文内容，用来验证质量判据在正常输入上的表现。`).join("\n\n");
    const q = assessQuality(body, []);
    expect(q.label).toBe("clean");
    expect(q.score).toBeGreaterThanOrEqual(90);
  });
});
