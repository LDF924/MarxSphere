// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// blob-selftest.ts — 对象存储兼容性自检（上目标厂商前跑一次）
//
// 由来(2026-09-11): S3 驱动在 MinIO 上全绿, 但各家"S3 兼容"实现细节有差异
// (阿里云 OSS / 腾讯云 COS 的签名与 region 处理就和 AWS 不完全一样)。
// 换厂商时最怕的是"部分能用" —— 小对象能写、中文 key 404、或删不掉, 上线后才暴露。
//
// 用法:
//   BLOB_DRIVER=s3 S3_ENDPOINT=... S3_BUCKET=... S3_REGION=... \
//   S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
//   npx tsx scripts/blob-selftest.ts
//
// 需要的权限: 该桶的 PutObject / GetObject / DeleteObject / ListObjects(前缀内即可)。
// 桶若不存在会给出提示(不自动建桶 —— 建桶需要额外权限, 且厂商参数不同)。
//
// 退出码: 0 全过; 1 有失败项(CI 可直接卡住)。
import { buildBlobDriver, resetBlobDriver, type BlobDriver } from "../src/services/blob-store.js";
import { createHash } from "node:crypto";

const PREFIX = `selftest/${Date.now().toString(36)}`;
let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, extra = ""): void {
  if (ok) { pass++; console.log(`  ✓ ${label}${extra ? "  " + extra : ""}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? "  " + extra : ""}`); }
}

async function main(): Promise<void> {
  console.log("═══ 对象存储自检 ═══");
  console.log(`驱动=${process.env.BLOB_DRIVER || "local"} 端点=${process.env.S3_ENDPOINT || "(未配)"} 桶=${process.env.S3_BUCKET || "(未配)"} 区域=${process.env.S3_REGION || "us-east-1"}`);
  console.log("");

  resetBlobDriver();
  let d: BlobDriver;
  try {
    d = buildBlobDriver();
  } catch (e) {
    console.error(`✗ 驱动构造失败: ${String((e as Error)?.message || e)}`);
    process.exit(1);
  }
  if (d.name !== "s3") {
    console.log(`提示: 当前驱动是 ${d.name}(本地盘/共享卷), 本自检针对对象存储。设 BLOB_DRIVER=s3 再跑。`);
    process.exit(0);
  }
  console.log(`目标驱动: ${d.name}\n`);

  const cases: Array<[string, string, Buffer]> = [
    ["纯 ASCII key", `${PREFIX}/ascii/a.bin`, Buffer.from("hello")],
    ["中文+空格 key", `${PREFIX}/中文 目录/图 表.png`, Buffer.from("中文内容")],
    ["特殊字符 key", `${PREFIX}/plus+hash#amp&amp/weird~!.txt`, Buffer.from("special")],
    ["深层路径 key", `${PREFIX}/a/b/c/d/e/deep.bin`, Buffer.from("deep")],
    ["1MB 二进制", `${PREFIX}/big.bin`, Buffer.from(Array.from({ length: 1024 * 1024 }, (_, i) => (i * 31 + 7) % 256))],
  ];

  // ── 写入 / 读回 / 字节一致性 ──
  for (const [label, key, data] of cases) {
    try {
      await d.put(key, data);
      const back = await d.get(key);
      const same = back && createHash("sha256").update(back).digest("hex") === createHash("sha256").update(data).digest("hex");
      check(`${label} 写入→读回`, Boolean(same), `${data.length} 字节`);
    } catch (e) {
      check(`${label} 写入→读回`, false, String((e as Error)?.message || e).slice(0, 140));
    }
  }

  // ── 存在性 / 缺失语义 ──
  try {
    const e1 = await d.exists(cases[0][1]);
    const e2 = await d.exists(`${PREFIX}/definitely-not-here.bin`);
    check("HEAD 存在性", e1 === true && e2 === false, `有=${e1} 无=${e2}`);
  } catch (e) {
    check("HEAD 存在性", false, String((e as Error)?.message || e).slice(0, 140));
  }
  try {
    const missing = await d.get(`${PREFIX}/definitely-not-here.bin`);
    check("缺失对象返回 null(而非抛错)", missing === null);
  } catch (e) {
    check("缺失对象返回 null(而非抛错)", false, String((e as Error)?.message || e).slice(0, 140));
  }

  // ── 列举(报告导出要先用它取图) ──
  try {
    const list = await d.list(`${PREFIX}`);
    check("列举前缀下对象", list.length >= cases.length, `列出 ${list.length} 个(期望 ≥${cases.length})`);
  } catch (e) {
    check("列举前缀下对象", false, String((e as Error)?.message || e).slice(0, 140));
  }

  // ── 覆盖写 ──
  try {
    await d.put(cases[0][1], Buffer.from("第二版"));
    const v2 = await d.get(cases[0][1]);
    check("同 key 覆盖写", v2?.toString("utf-8") === "第二版");
  } catch (e) {
    check("同 key 覆盖写", false, String((e as Error)?.message || e).slice(0, 140));
  }

  // ── 越界防护(不能把对象写到前缀之外) ──
  let blocked = false;
  try {
    await d.put("../escaped.bin", Buffer.from("x"));
  } catch { blocked = true; }
  check("key 上跳被拒", blocked);

  // ── 删除 + 幂等 ──
  try {
    await d.del(cases[0][1]);
    const gone = await d.exists(cases[0][1]);
    await d.del(cases[0][1]); // 重复删不应抛
    check("删除生效且幂等", gone === false);
  } catch (e) {
    check("删除生效且幂等", false, String((e as Error)?.message || e).slice(0, 140));
  }

  // ── 清理自检残留 ──
  let cleaned = 0;
  try {
    for (const k of await d.list(PREFIX)) { await d.del(k); cleaned++; }
  } catch { /* 清不干净不影响结论 */ }
  console.log(`\n已清理自检对象 ${cleaned} 个`);

  console.log(`\n═══ 结果: ${pass} 通过 / ${fail} 失败 ═══`);
  if (fail > 0) {
    console.log("有失败项 —— 该厂商的 S3 兼容实现与本驱动存在差异, 切换前需先修(常见: 签名参数、region 处理、中文 key 编码)");
  } else {
    console.log("全部通过 —— 该厂商可用于本项目的对象存储驱动");
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("自检异常终止:", String(e?.stack || e).slice(0, 800));
  process.exit(1);
});
