// 项目整包导出的 zip 组装器(V425 A3)
//
// 为什么值得单测: 这段代码**自己拼二进制格式**(本地文件头 / 中央目录 / EOCD / CRC32),
//   没有任何库兜底 —— 字段偏移写错一个字节, zip 就是坏的, 而**运行时不报错**:
//   服务照样 200、字节照样吐出来, 只有用户双击打不开。
//   门禁探针能证明"我们这边的解析器读得出", 那还不够(两边一起错就查不出来)。
//   这里用 **Python 的 zipfile**(独立实现, 且就是资源管理器那套格式的参照)来读,
//   能读通才算格式对。
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { __testables } from "../src/services/project-export-service.js";
import { resolvePython } from "../src/services/py-path.js";

const { buildZip, safeName } = __testables;

/** 让 python 读一遍 zip 并回报"每个条目的原名 + 内容长度 + 内容 sha256" */
function readZipWithPython(buf: Buffer): Array<{ name: string; len: number; crc: number }> {
  const dir = mkdtempSync(path.join(tmpdir(), "zipcheck-"));
  const fp = path.join(dir, "t.zip");
  writeFileSync(fp, buf);
  try {
    const out = execFileSync(resolvePython(), ["-c", `
import zipfile, json, sys
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
res = [{"name": i.filename, "len": i.file_size, "crc": i.CRC, "data": z.read(i.filename).decode("utf-8")} for i in z.infolist()]
print(json.dumps({"bad": bad, "items": res}))
`, fp], { encoding: "utf-8", timeout: 30_000 });
    const j = JSON.parse(out.trim().split("\n").pop() as string) as { bad: string | null; items: Array<{ name: string; len: number; crc: number }> };
    // Python 自己会报哪个条目 CRC 对不上 —— 这是对我们手写 CRC32 的独立校验
    expect(j.bad).toBeNull();
    return j.items;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("buildZip — 自写 zip 容器的格式正确性", () => {
  it("Python zipfile 能读通, 且中文文件名不乱码", () => {
    const entries = [
      { name: "README.md", data: Buffer.from("# 标题\n\n中文内容", "utf8") },
      { name: "章节/01-引言.md", data: Buffer.from("正文".repeat(50), "utf8") },
    ];
    const items = readZipWithPython(buildZip(entries));
    expect(items.map((i) => i.name)).toEqual(["README.md", "章节/01-引言.md"]);
    expect(items[1].len).toBe(Buffer.byteLength("正文".repeat(50), "utf8"));
  });

  it("CRC32 与独立实现一致(手写查表法最容易在这里整片错)", () => {
    // 已知向量: "123456789" 的 CRC32 是 0xCBF43926(标准测试向量)
    expect(__testables.crc32(Buffer.from("123456789", "ascii"))).toBe(0xcbf43926);
  });

  it("内容能原样取回(压缩路径与直存路径都要对)", () => {
    const big = Buffer.from("可压缩内容".repeat(500), "utf8");   // 会走 deflate
    const tiny = Buffer.from("x", "utf8");                       // deflate 后更大 → 走 store
    const buf = buildZip([{ name: "big.txt", data: big }, { name: "tiny.txt", data: tiny }]);
    const items = readZipWithPython(buf) as unknown as Array<{ name: string; data: string }>;
    expect(items.find((i) => i.name === "big.txt")!.data).toBe(big.toString("utf8"));
    expect(items.find((i) => i.name === "tiny.txt")!.data).toBe("x");
  });

  it("空文件与多级目录路径都成立(zip 目录条目不单列, 靠路径自动建目录)", () => {
    const items = readZipWithPython(buildZip([
      { name: "a/b/c/deep.md", data: Buffer.from("深层", "utf8") },
      { name: "empty.md", data: Buffer.alloc(0) },
    ]));
    expect(items.map((i) => i.name)).toEqual(["a/b/c/deep.md", "empty.md"]);
  });

  it("EOCD 里的条目数与实际一致(写错会导致解压器只看到前 N 个文件)", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.md`, data: Buffer.from(`第${i}个`, "utf8") }));
    const items = readZipWithPython(buildZip(many));
    expect(items).toHaveLength(12);
    expect(items[11].name).toBe("f11.md");
  });
});

describe("safeName — 章节标题当文件名时的清洗", () => {
  it("去掉 Windows 非法字符", () => {
    expect(safeName('文献:综述/2024?', "兜底")).toBe("文献_综述_2024_");
    expect(safeName('a"b<c>d|e', "兜底")).toBe("a_b_c_d_e");
  });

  it("结尾的空格与点会被 Windows 静默截掉, 必须自己先剪", () => {
    expect(safeName("标题... ", "兜底")).toBe("标题");
    expect(safeName("标题 .", "兜底")).toBe("标题");
  });

  it("开头的点会让解压出来是隐藏文件, 也要剪", () => {
    expect(safeName(".hidden", "兜底")).toBe("hidden");
  });

  it("清洗后为空时用兜底名, 且长度有上限", () => {
    expect(safeName("   ", "未命名")).toBe("未命名");
    expect(safeName("长".repeat(200), "未命名")).toHaveLength(60);
  });
});
