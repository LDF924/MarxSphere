/**
 * service-token-risk.test.ts — 密钥对外暴露面的**跨端**门禁。
 *
 * 由来(2026-09-28): 加「外部服务密钥」这组路由时, 三处"漏了就是漏洞"的接线分散在
 *   两个语言、三个文件里, 类型系统一个都管不到:
 *
 *   ① **路由必须只在本机可用**。这组端点能写入一个"平台拿去调外部付费接口"的密钥 ——
 *      拿到外部令牌的第三方改掉它, 就能把用户文档导向自己控制的 OCR 账号。而
 *      `LOCAL_ONLY_PREFIXES` 是**前缀匹配**的字符串数组, 少一行不报错、不告警,
 *      表现是"接口照样能用"。
 *
 *   ② **响应体里不能有服务端密钥**。`service-token-store` 的注释立了这条规矩, 但
 *      漏一条出口就是漏一把钥匙 —— 所以这里直接**扫源码里的返回语句**。
 *
 *   ③ **子进程参数里的密钥要能抹掉**。密钥是通过 `--token` 命令行参数传给 Python 的,
 *      子进程失败时 adapter 会把 stdout 整段塞进 error。抹除函数存在 ≠ 被调用了。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("外部服务密钥的暴露面", () => {
  it("路由前缀在本机白名单里(否则外部令牌可改密钥)", () => {
    const src = read("src/api/server.ts");
    const at = src.indexOf("const LOCAL_ONLY_PREFIXES = [");
    expect(at, "找不到 LOCAL_ONLY_PREFIXES —— 源码结构变了, 请同步本文件的解析").toBeGreaterThan(0);
    // 数组字面量段: 从声明处取到第一个 `];`
    const block = src.slice(at, src.indexOf("];", at));
    expect(block, "密钥路由不在 LOCAL_ONLY_PREFIXES 里 —— 外部令牌将能改平台的外部服务密钥").toContain('"/api/service-tokens"');
  });

  it("密钥路由有权限前缀映射(兜底默认放行, 不映射等于向外部令牌开放)", () => {
    const src = read("src/api/server.ts");
    const at = src.indexOf("PERMISSION_PREFIX_MAP");
    const block = src.slice(at, src.indexOf("];", at));
    expect(block).toContain('["/api/ocr"');
  });

  it("service-token-store 的返回语句里不出现 token 值字段", () => {
    const src = read("src/services/service-token-store.ts");
    const lines = src.split(/\r?\n/);
    const offenders: string[] = [];
    lines.forEach((line, i) => {
      // 只看返回/赋值给视图对象的那类行, 别把 SQL 的 returning 误判进来
      if (!/^\s*(token|value)\s*:/.test(line)) return;
      offenders.push(`${i + 1}: ${line.trim()}`);
    });
    expect(
      offenders,
      "脱敏视图里出现了 token/value 字段。它是唯一出 API 的形状, 加字段前先问: 能不能反推出密钥?",
    ).toEqual([]);
  });

  it("OCR 任务失败路径**调用了**密钥抹除(函数存在不等于被调用)", () => {
    const src = read("src/services/ocr-job-service.ts");
    // 抛错那一行必须同时经过 redactToken
    const lines = src.split(/\r?\n/);
    const catchLine = lines.find((l) => l.includes("translateOcrError(") && l.includes("redactToken("));
    expect(
      catchLine,
      "失败路径没有把错误文本过一遍 redactToken —— 子进程参数里带着密钥, 它会顺着 error 进 API 响应与日志",
    ).toBeTruthy();
  });

  it("OCR 路由经过 requireUser(否则任务能用别人的 id 读)", () => {
    const src = read("src/api/server.ts");
    const at = src.indexOf('app.post("/api/ocr/jobs"');
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, at + 300);
    expect(block).toContain("requireUser(request, reply)");
  });
});
