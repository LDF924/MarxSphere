/**
 * docx-build.test.ts — Word 成品构建(LaTeX→OMML 公式 / 封面+目录)。
 *
 * 由来(2026-10-01): 这两项从旧项目 AItoolman 移植而来(它的明文源码随包分发,
 *   是本仓库唯一可直搬的部分)。移植前本仓库 `grep OMML/latex2mathml` = 0 ——
 *   导出的 Word 里公式是纯文本, 且**没有封面、没有目录**。
 *
 * 这个文件盯四件事:
 *   ① 产物里必须是**真 OMML 公式**(`<m:oMath>`), 不是图片也不是纯文本 ——
 *      这是"移植成功"与"看着像成功"的分界; 只要有人把 `_converter.convert` 换成
 *      直接写文本, 这条会红。
 *   ② 目录必须是 **TOC 域**(fldChar), 且带 `w:updateFields` ——
 *      少了后者, 用户打开 Word 看到的是占位提示而不是目录, 而文件"生成成功"。
 *   ③ 旧项目里的**危险启发式**不许被搬进来: 原版"删除第一个看起来像标题的短段落"
 *      会把正文首句(如"研究背景与意义")当标题删掉。移植时有意去掉, 这里守住。
 *   ④ 调试 print 不许回潮: 原版 `latex_to_docx.py` 有 8 处 `print('处理N:', ...)`,
 *      它会污染 stdout 让调用方 JSON 解析崩 —— 而"崩"发生在**别人调用时**,
 *      本文件是自己测自己, 所以直接把源码当判据。
 *
 * ⚠ python 依赖(python-docx/latex2mathml/lxml)缺失时整组 skip —— 与
 *   `file-text-service.test.ts` 对 DB、`v399-integration.test.ts` 对 Python 的处理一致。
 *   否则在没装依赖的机器上会报一堆栈, 看着像"改动搞挂了测试"。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  latexToDocx,
  addCoverAndToc,
  checkDocxBuildDeps,
} from "../src/services/docx-build-service.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LATEX_PY = path.join(ROOT, "scripts", "latex_to_docx.py");
const COVER_PY = path.join(ROOT, "scripts", "add_cover_and_toc.py");

const deps = await checkDocxBuildDeps();
if (!deps.ok) {
  console.warn(
    `[docx-build] python 依赖缺失 ${JSON.stringify(deps.missing)} —— 本组跳过。\n` +
      `  装依赖: pip install python-docx latex2mathml lxml`,
  );
}

/** 解开 docx(zip), 取指定成员的内容 */
function readZipPart(file: string, member: string): string {
  // 用 python 解, 免得引 zip 库依赖
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  return execFileSync(deps.python, [
    "-c",
    `import zipfile,sys; sys.stdout.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]).decode("utf-8"))`,
    file,
    member,
  ], { encoding: "utf8", windowsHide: true });
}

const SAMPLE = String.raw`偏向机制的核心刻画如下：

$$P = f(X, W, \Theta)$$

其中 \( P \) 为路径结果向量[1]，\\( \Theta \\) 为参数集。验证误差：

$$E = \| \hat{P} - P \|_2^2 + \lambda \| \Theta \|_1$$

求和与根式：

$$\sum_{i=1}^{n} x_i^2 \quad \sqrt{\frac{a+b}{c-d}}$$
`;

describe.skipIf(!deps.ok)("Word 成品构建: LaTeX → OMML 真公式", () => {
  it("转换成功且报告了公式条数", async () => {
    const r = await latexToDocx({ content: SAMPLE, title: "测试稿", fontName: "宋体", fontSize: 12 });
    expect(r.ok, `转换失败: ${r.error}`).toBe(true);
    expect(r.base64 && r.base64.length).toBeGreaterThan(1000);
    // 3 个行间 + 2 个行内 = 5
    expect(r.meta?.formulas).toBe(5);
  });

  it("**产物里是真 OMML**(`<m:oMath>`), 不是图片也不是纯文本", async () => {
    const r = await latexToDocx({ content: SAMPLE });
    expect(r.ok).toBe(true);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tst-omml-"));
    const f = path.join(dir, "a.docx");
    fs.writeFileSync(f, Buffer.from(r.base64!, "base64"));
    try {
      const xml = readZipPart(f, "word/document.xml");
      // 行间公式包在 oMathPara 里; 行内的直接是 oMath
      expect(xml.match(/<m:oMathPara>/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
      expect(xml).toContain("<m:oMath");
      // 结构级: 这几种算符各自被真的建模了(而不是当字符串塞进去)
      expect(xml).toContain("<m:f>");      // 分数
      expect(xml).toContain("<m:rad>");    // 根号
      expect(xml).toContain("<m:nary>");   // ∑ 这类 N 元运算
      // 定界符不许漏到正文里
      expect(xml).not.toContain("$$");
      expect(xml).not.toContain(String.raw`\(`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("中文排班写进 eastAsia, 引文 [1] 变上标", async () => {
    const r = await latexToDocx({ content: SAMPLE, fontName: "楷体" });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tst-cjk-"));
    const f = path.join(dir, "a.docx");
    fs.writeFileSync(f, Buffer.from(r.base64!, "base64"));
    try {
      const styles = readZipPart(f, "word/styles.xml");
      expect(styles).toContain(`eastAsia="楷体"`);
      const xml = readZipPart(f, "word/document.xml");
      expect(xml).toContain("superscript");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("空内容被挡下(不生成空文档)", async () => {
    const r = await latexToDocx({ content: "   " });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("空");
  });
});

describe.skipIf(!deps.ok)("Word 成品构建: 封面 + 目录(TOC 域)", () => {
  it("**目录是 TOC 域, 且写了 updateFields**(否则用户看到的是占位提示)", async () => {
    const made = await latexToDocx({ content: SAMPLE, title: "" });
    expect(made.ok).toBe(true);

    const r = await addCoverAndToc({
      docxBase64: made.base64!,
      title: "偏向机制研究",
      engine: "python",
    });
    expect(r.ok, `封面目录失败: ${r.error}`).toBe(true);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tst-toc-"));
    const f = path.join(dir, "c.docx");
    fs.writeFileSync(f, Buffer.from(r.base64!, "base64"));
    try {
      const xml = readZipPart(f, "word/document.xml");
      expect(xml).toContain("fldCharType");
      expect(xml).toContain("TOC");
      // 域要成对: begin 与 end 数量一致(缺 end 会让 Word 报文件损坏)
      const begins = xml.match(/fldCharType="begin"/g)?.length ?? 0;
      const ends = xml.match(/fldCharType="end"/g)?.length ?? 0;
      expect(begins).toBeGreaterThan(0);
      expect(begins).toBe(ends);

      const settings = readZipPart(f, "word/settings.xml");
      expect(settings).toContain("updateFields");

      expect(xml).toContain("偏向机制研究"); // 封面标题
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("封面位置三档都认(high/center/low 不报错)", async () => {
    const made = await latexToDocx({ content: SAMPLE });
    for (const position of ["high", "center", "low"] as const) {
      const r = await addCoverAndToc({
        docxBase64: made.base64!, title: "位置测试", position, engine: "python",
      });
      expect(r.ok, `${position} 失败: ${r.error}`).toBe(true);
    }
  }, 120_000);

  it("空 base64 被挡下", async () => {
    const r = await addCoverAndToc({ docxBase64: "" });
    expect(r.ok).toBe(false);
  });
});

/**
 * 源码级判据 —— 守的是"移植时有意做的修正别被回退"。
 *
 * 这三条都**不是**在测行为, 而是在测"那段被我们改掉的旧代码有没有爬回来":
 *   · 调试 print —— 回潮会污染 stdout, 崩的是调用方
 *   · 危险启发式 —— 回潮会误删正文首段, 且删完文档看着还正常
 *   · argv 传参 —— 回潮会让含 `\` 的中文在 Windows 上被 cmd 吃掉
 */
describe("移植修正不许回退(源码级)", () => {
  const latexSrc = fs.readFileSync(LATEX_PY, "utf8");
  const coverSrc = fs.readFileSync(COVER_PY, "utf8");

  it("latex_to_docx.py 里没有调试 print(原版有 8 处, 会污染 stdout)", () => {
    // 允许 print(json.dumps(...)) —— 那是 CLI 的正当输出
    const bad = [...latexSrc.matchAll(/^\s*print\((?!json\.dumps)/gm)];
    expect(
      bad.map((m) => m[0].trim()),
      "出现了调试 print —— 它会让 stdout 多出非 JSON 行, 调用方解析崩",
    ).toEqual([]);
  });

  it("两个脚本都用 stdin 读 JSON(不用 argv 传正文)", () => {
    for (const [name, src] of [["latex_to_docx.py", latexSrc], ["add_cover_and_toc.py", coverSrc]] as const) {
      expect(src, `${name} 没读 stdin`).toContain("sys.stdin.read()");
    }
  });

  it("**没有把原版那条危险启发式搬进来**(删第一个像标题的短段落)", () => {
    // 原版策略③会误删正文首句。判据: 源码里不该再出现"删第一段"的表述
    expect(
      /删除第一个看起来像标题的短段落/.test(coverSrc),
      "原版的危险启发式回来了 —— 它会把正文首句当标题删掉",
    ).toBe(false);
    // 我们的实现只保留"居中段落"与"标题文本精确匹配"两条可判定的策略
    expect(coverSrc).toContain("WD_ALIGN_PARAGRAPH.CENTER");
  });

  it("脚本文件真的存在(防判据指向不存在的东西)", () => {
    expect(fs.existsSync(LATEX_PY)).toBe(true);
    expect(fs.existsSync(COVER_PY)).toBe(true);
  });
});
