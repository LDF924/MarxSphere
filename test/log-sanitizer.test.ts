// log-sanitizer.test.ts — 日志脱敏单测（P0-15）
import { describe, it, expect } from "vitest";
import { sanitizeLine, sanitizeObject, hasSuspiciousContent } from "../src/services/log-sanitizer.js";

describe("sanitizeLine（正则层）", () => {
  it("身份证 → [REDACTED:ID]", () => {
    expect(sanitizeLine("用户身份证 110101199003078815 处理中")).toContain("[REDACTED:ID]");
  });

  it("手机号 → [REDACTED:PHONE]", () => {
    expect(sanitizeLine("联系 13812345678")).toContain("[REDACTED:PHONE]");
  });

  it("银行卡 → [REDACTED:BANKCARD]", () => {
    expect(sanitizeLine("卡号 6222021234567890123")).toContain("[REDACTED:BANKCARD]");
  });

  it("IPv4 → [REDACTED:IP]", () => {
    expect(sanitizeLine("来源 192.168.1.100 访问")).toContain("[REDACTED:IP]");
  });

  it("sk-key → [REDACTED:API_KEY]", () => {
    expect(sanitizeLine("key=sk-abcdefghijklmnopqrstuvwxyz123456")).toContain("[REDACTED:API_KEY]");
  });

  it("Authorization Bearer → [REDACTED:AUTH]", () => {
    expect(sanitizeLine("Authorization: Bearer abcdef123456")).toContain("[REDACTED:AUTH]");
  });

  it("正常日志无误伤", () => {
    const normal = "检索完成，找到 5 篇论文，耗时 12.3s";
    expect(sanitizeLine(normal)).toBe(normal);
  });
});

describe("sanitizeObject", () => {
  it("递归脱敏对象字符串字段", () => {
    const obj = { user: "张三", phone: "13812345678", nested: { id: "110101199003078815" } };
    const out = sanitizeObject(obj) as any;
    expect(out.phone).toContain("[REDACTED:PHONE]");
    expect(out.nested.id).toContain("[REDACTED:ID]");
  });
});

describe("hasSuspiciousContent", () => {
  it("含敏感关键词段落识别", () => {
    expect(hasSuspiciousContent("请提供身份证和手机号")).toBe(true);
    expect(hasSuspiciousContent("检索论文数据")).toBe(false);
  });
});
