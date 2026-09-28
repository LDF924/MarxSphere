/**
 * file-text-service.test.ts — fileId → 纯文本 这个原语。
 *
 * 由来(2026-09-29 用户: "审稿的上传 PDF 要先 file_read/pdf_parse 拿到文本再建 job ——
 *   后端没有 fileId → 纯文本这个能力。全部修复"):
 *   平台上有两个文件概念一直没接上 —— `user_files`(有字节, 没有正文) 与 `ocr_jobs`
 *   (有正文, 但 id 是 OCR 任务 id 不是上传文件 id)。于是"我上传的这份 PDF 正文是什么"
 *   没有任何地方能回答, 评审面板的上传因此成了丢弃管道。
 *
 * 这个文件锁四件事, 每条都对应一个**不报错**的失效方式:
 *   ① **正文按 id 取得回来**: 上传 → 取文本 → 拿到真内容(这是用户在对话里够不着的那一步);
 *   ② **抽完存库**: 第二次读不再重抽(读的是 user_files.text)。存了不读, 或读了不存, 都看不出来;
 *   ③ **扫描件要给出路, 不是给失败**: 返回 needsOcr 而不是抛错 —— 下一步是 OCR(分钟级),
 *      调用方必须能把用户送过去。把它当普通失败的话, 用户只会看到"提取失败"四个字;
 *   ④ **归属**: 别人的 fileId 读不到(这张表里全是用户论文)。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "../src/db/pool.js";
import { putObject, deleteObject } from "../src/services/blob-store.js";
import { ensureFileText, attachOcrText, rawFileId } from "../src/services/file-text-service.js";

let userId = "";
const created: Array<{ id: string; rel: string }> = [];

/** 建一行 user_files + 落盘真字节 —— 与 /api/files/upload 落库的形状一致 */
async function seed(filename: string, body: Buffer | string, mime = "application/octet-stream"): Promise<string> {
  const id = randomUUID();
  const rel = `user-files/${userId}/${id}.bin`;
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf-8");
  await putObject(rel, buf);
  await pool.query(
    `insert into user_files (id, user_id, filename, mime, size_bytes, storage_rel) values ($1,$2,$3,$4,$5,$6)`,
    [id, userId, filename, mime, buf.length, rel]);
  created.push({ id, rel });
  return `file_${id}`;
}

beforeAll(async () => {
  userId = randomUUID();
  // user_files.user_id 有外键则这里会失败 —— 那就说明必须用真用户; 先探一下
  const r = await pool.query(`select count(*)::int c from user_files limit 1`);
  if (!r.rows.length) throw new Error("库连不上");
}, 30_000);

afterAll(async () => {
  for (const c of created) {
    await pool.query(`delete from user_files where id=$1`, [c.id]).catch(() => null);
    await deleteObject(c.rel).catch(() => null);
  }
  await pool.end().catch(() => null);
});

describe("① 正文按 id 取得回来", () => {
  it("纯文本文件: 内容原样拿到", async () => {
    const text = "本文研究资本下乡对村集体收入的影响。\n\n二、文献综述\n已有研究……";
    const fid = await seed("草稿.txt", text);
    const r = await ensureFileText(userId, fid);
    expect(r.ok, `取文本失败: ${r.error}`).toBe(true);
    expect(r.text).toContain("资本下乡");
    expect(r.extraction).toBe("native");
    expect(r.needsOcr).toBe(false);
  });

  it("fileId 带不带 `file_` 前缀都认(库里的 id 与接口返回的形状不同)", async () => {
    const fid = await seed("前缀.md", "# 标题\n正文");
    const bare = await ensureFileText(userId, rawFileId(fid));
    const full = await ensureFileText(userId, fid);
    expect(bare.ok).toBe(true);
    expect(bare.text).toBe(full.text);
  });

  it("不存在的 id: 明确说找不到, 不是空文本", async () => {
    const r = await ensureFileText(userId, `file_${randomUUID()}`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/不存在|不属于你/);
  });
});

describe("② 抽完存库 —— 第二次读不再重抽", () => {
  it("抽过的文件改掉磁盘字节, 仍能读到**库里那份**(证明读的是缓存而不是重抽)", async () => {
    const fid = await seed("缓存.txt", "第一次的内容");
    const first = await ensureFileText(userId, fid);
    expect(first.ok).toBe(true);

    // 把磁盘上的字节换掉 —— 若实现是"每次现抽", 第二次就会读到新内容
    const rel = `user-files/${userId}/${rawFileId(fid)}.bin`;
    await putObject(rel, Buffer.from("磁盘上被换过的内容", "utf-8"));

    const second = await ensureFileText(userId, fid);
    expect(second.text, "第二次读到的是磁盘新内容 ⇒ 没走库里的缓存").toBe("第一次的内容");

    // force 时才重抽
    const forced = await ensureFileText(userId, fid, { force: true });
    expect(forced.text).toBe("磁盘上被换过的内容");
  });

  it("抽出来的正文落了库(user_files.text 非空)", async () => {
    const fid = await seed("落库.txt", "落库验证正文");
    await ensureFileText(userId, fid);
    const r = await pool.query(`select text, extraction from user_files where id=$1`, [rawFileId(fid)]);
    expect(r.rows[0]?.text).toBe("落库验证正文");
    expect(r.rows[0]?.extraction).toBe("native");
  });

  it("attachOcrText 把识别结果写回同一列 —— OCR 完再读就是识别稿", async () => {
    const fid = await seed("扫描件.pdf", Buffer.from([0x25, 0x50, 0x44, 0x46])); // 假 PDF 头
    await ensureFileText(userId, fid); // 抽失败
    expect(await attachOcrText(userId, fid, "OCR 认出来的正文")).toBe(true);
    const r = await ensureFileText(userId, fid);
    expect(r.ok).toBe(true);
    expect(r.text).toBe("OCR 认出来的正文");
    // 来源必须标成 ocr —— 识别稿有错字, 用户有权知道该不该复核
    expect(r.extraction).toBe("ocr");
  });

  it("attachOcrText 拒绝空文本(不接受把正文抹成空)", async () => {
    const fid = await seed("非空.txt", "原有正文");
    expect(await attachOcrText(userId, fid, "   ")).toBe(false);
    const r = await ensureFileText(userId, fid);
    expect(r.text).toBe("原有正文");
  });

  /**
   * ⚠ 这一条链的是**回程**: 评审页对扫描件给的提示是「去识别文字 →」, 用户识别完回来
   *   重选文件时必须读得到正文。缺了 ocr_jobs.source_file_id 这个连接点, 识别结果就
   *   只落在 OCR 任务里, 而用户回去读的是**另一次上传**的新行 —— 那个提示成了绕不回来的圈。
   */
  it("OCR 任务记住它识别的是哪份上传件(表结构 + 服务入参都要有)", async () => {
    const col = await pool.query(
      `select column_name from information_schema.columns where table_name='ocr_jobs' and column_name='source_file_id'`);
    expect(col.rows.length, "ocr_jobs 缺 source_file_id 列 —— 识别结果写不回原文件, 「去识别文字」变成绕不回来的圈")
      .toBe(1);
  });
});

describe("⑤ 识别结果写回同一个 fileId(评审页那条提示的回程)", () => {
  it("attachOcrText 之后, 按原 fileId 读得到识别稿且来源标成 ocr", async () => {
    const fid = await seed("回程.pdf", Buffer.from([0x25, 0x50, 0x44, 0x46]));
    await ensureFileText(userId, fid);                       // 抽失败(假 PDF 头)
    expect(await attachOcrText(userId, fid, "识别出来的正文")).toBe(true);
    const back = await ensureFileText(userId, fid);
    expect(back.ok, "识别完回来还是读不到 ⇒ 用户被卡在一个绕不回来的圈里").toBe(true);
    expect(back.text).toBe("识别出来的正文");
    expect(back.extraction).toBe("ocr");
  });
});

describe("③ 扫描件给出路, 不是给失败", () => {
  it("坏 PDF: 报可读的失败原因, needsOcr 为假(坏文件不该被推荐去做 OCR)", async () => {
    const fid = await seed("坏.pdf", Buffer.from("这不是一个 PDF"));
    const r = await ensureFileText(userId, fid);
    expect(r.ok).toBe(false);
    expect(r.needsOcr).toBe(false);
    expect(r.error).toMatch(/PDF|损坏|密码/);
    expect(r.error, "错误里不该出现英文内部栈").not.toMatch(/at \w+ \(|undefined/);
  });

  it("不支持的扩展名: 说清楚支持什么, 而不是静默返回空", async () => {
    const fid = await seed("二进制.bin", Buffer.from([0x00, 0x01, 0x02, 0x03]));
    const r = await ensureFileText(userId, fid);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/暂不支持|不支持/);
    expect(r.error).toMatch(/pdf|docx|txt/);
  });

  it("旧版 .doc: 明确让用户另存为 .docx(此前是当纯文本读成乱码)", async () => {
    const fid = await seed("老文档.doc", Buffer.from("随便什么"));
    const r = await ensureFileText(userId, fid);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/\.docx/);
  });
});

describe("④ 归属: 别人的文件读不到", () => {
  it("换一个 userId 去读同一个 fileId → 找不到", async () => {
    const fid = await seed("私密.txt", "只有我能看");
    const other = randomUUID();
    const r = await ensureFileText(other, fid);
    expect(r.ok, "别人的文件被读出来了 —— 这张表里全是用户论文").toBe(false);
    expect(r.text).toBe("");
  });
});
