/**
 * service-token.test.ts — 锁住「外部服务密钥」的三条硬约束。
 *
 * 由来(2026-09-28): MinerU 的 OCR token 在 2026-09-16 悄悄过期, 11 天后才被发现。
 *   修法有两个容易做错的点, 各配一条断言:
 *
 *   ① **密钥不能从任何出口漏出去**。它经过的路径比看上去多: 响应体、告警文案、
 *      以及子进程失败时被塞进 error 的那段 stdout(密钥是通过 `--token` 命令行参数
 *      传下去的, 所以进程参数里就有它)。漏一条路径就等于把它抄送到四个地方。
 *
 *   ② **到期日分档不能模糊**。"有值但不知道什么时候到期"必须与"还有 200 天"分开 ——
 *      合成一档的话, 界面上会显示成正常, 而那正是这次事故的形态(没人知道它什么时候过期)。
 *
 *   ③ **不猜到期日**。签发方今天是 90 天, 不代表明天还是; 拿 `签发日 + 90` 冒充到期日,
 *      在对方改策略之后会**静默算错**, 而算错的后果是"以为还早, 实际早就过期了"。
 */
import { describe, it, expect } from "vitest";
import { redactToken, translateOcrError } from "../src/services/ocr-job-service.js";
import { decodeJwtExpiry, daysUntil, statusOf, EXPIRING_SOON_DAYS } from "../src/services/service-token-store.js";

/** 造一枚带指定 exp 的假 JWT(只需载荷可解, 签名不参与解析) */
function jwtWith(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS512", typ: "JWT" })}.${b64(payload)}.fakesig`;
}

describe("密钥不外泄", () => {
  const SECRET = "sk-WPM5tgkcufZaXy9MVZ7BW81cvlwBpeuVOGG9Wf9sscFSIz5u";

  it("原样出现的密钥被抹掉", () => {
    expect(redactToken(`调用失败: ${SECRET} 被拒绝`, SECRET)).not.toContain(SECRET);
  });

  it("**未知**密钥(没传第二个参数)也要抹 —— 兜底靠形态识别", () => {
    // 这条是要点: 调用方可能拿不到 token(它没配/读失败), 省略参数是常态
    const out = redactToken(`subprocess failed: --token ${SECRET} --api-mode precision`);
    expect(out).not.toContain(SECRET);
    expect(out).toContain("--token sk-***");
  });

  it("Authorization 头形态一并处理", () => {
    expect(redactToken(`401 from https://mineru.net with Bearer ${SECRET}`)).not.toContain(SECRET);
  });

  it("错误翻译的产物里不含密钥", () => {
    const translated = translateOcrError(redactToken(`HTTP 401: token ${SECRET} expired`, SECRET));
    expect(translated.userMessage).not.toContain(SECRET);
    // 翻译要给出**可操作**的一句话, 而不是把远端英文原样丢给用户
    expect(translated.userMessage).toContain("密钥");
    expect(translated.canRetry).toBe(false);
  });
});

describe("到期日分档", () => {
  it("没有值 → unconfigured(引导去配, 不是报错)", () => {
    expect(statusOf(null, false)).toBe("unconfigured");
  });

  it("**有值但到期日未知 → unknown**, 不能混进 ok", () => {
    // 这条正是本次事故的形态: 密钥存在、界面上"有配置", 但没人知道它什么时候失效
    expect(statusOf(null, true)).toBe("unknown");
  });

  it("已过期 → expired; 今天到期 → expiring(提醒档, 不是 ok)", () => {
    expect(statusOf(-1, true)).toBe("expired");
    // 0 天的语义是"今天就失效", 归到**提醒档** —— 归 ok 的话界面上它和"还剩一年"长得一样,
    // 而用户恰恰需要在这一天被叫住
    expect(statusOf(0, true)).toBe("expiring");
  });

  it(`剩 ${EXPIRING_SOON_DAYS} 天以内 → expiring`, () => {
    expect(statusOf(EXPIRING_SOON_DAYS, true)).toBe("expiring");
    expect(statusOf(EXPIRING_SOON_DAYS - 1, true)).toBe("expiring");
  });

  it("还早 → ok", () => {
    expect(statusOf(EXPIRING_SOON_DAYS + 1, true)).toBe("ok");
  });
});

describe("JWT 到期日解析", () => {
  it("读得出来就精确到秒", () => {
    const exp = 1_789_581_189; // 实测那枚密钥的 exp
    expect(decodeJwtExpiry(jwtWith({ exp }))?.getTime()).toBe(exp * 1000);
  });

  it("**不是 JWT 就返回 null, 不猜**", () => {
    expect(decodeJwtExpiry("sk-a-plain-token")).toBeNull();
    expect(decodeJwtExpiry("")).toBeNull();
    // 三段但载荷不是 JSON
    expect(decodeJwtExpiry("aaa.!!!not-base64-json!!!.ccc")).toBeNull();
  });

  it("没有 exp 字段也返回 null(不是 0, 也不是现在)", () => {
    expect(decodeJwtExpiry(jwtWith({ iat: 1 }))).toBeNull();
  });

  it("daysUntil 向上取整 —— 剩 0.4 天显示 1, 而不是 0", () => {
    const now = new Date("2026-09-28T00:00:00Z");
    expect(daysUntil(new Date("2026-09-28T09:36:00Z"), now)).toBe(1);
    expect(daysUntil(new Date("2026-09-29T00:00:00Z"), now)).toBe(1);
    expect(daysUntil(null, now)).toBeNull();
  });
});
