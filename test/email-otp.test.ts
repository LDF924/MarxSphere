/**
 * email-otp.test.ts — 邮箱验证码的安全性质。
 *
 * 由来(2026-10-01, 从旧项目移植「发送验证码」/「处理发送验证码成功的回调」):
 *   本仓此前只有重置链接没有验证码。本文件锁六条**安全性质**, 每条都对应一个真实攻击面,
 *   它们的共同点是"坏了也不会报错" —— 功能照常跑, 只是不再安全:
 *   ① 库里存的是哈希, 明文码取不回来;
 *   ② 过期作废(5 分钟);
 *   ③ 试错上限(5 次)且超限**立即作废**, 不是继续允许试;
 *   ④ 用量限流(同邮箱 60s/1h, 同 IP 1h);
 *   ⑤ 用途隔离(register 的码不能拿去 reset);
 *   ⑥ 一次性(校验成功即作废)。
 *   外加: 不存在的邮箱/不存在的码要给出**可读**的失败, 而不是静默返 false。
 *
 * ⚠ 这个文件**要真库**(限流计数走数据库, 不是内存 —— 多副本部署时内存计数各算各的,
 *   等于没限流), 所以连不上整组 skip, 与 test/file-text-service.test.ts 同一处理。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { pool } from "../src/db/pool.js";
import {
  sendOtp,
  verifyOtp,
  cleanupExpiredOtps,
  inspectActiveOtp,
  generateOtpCode,
  hashOtpCode,
  verifyOtpHash,
  normalizeEmail,
  isValidEmail,
  isValidPurpose,
  buildOtpEmailHtml,
  OTP_TTL_MINUTES,
  OTP_MAX_ATTEMPTS,
  OTP_EMAIL_HOURLY_LIMIT,
  OTP_IP_HOURLY_LIMIT,
  OTP_RESEND_WINDOW_SECONDS,
} from "../src/services/email-otp-service.js";

/** 与 file-text-service.test.ts 同一套: .env 只在主仓, worktree 里没有 → 必须能跳过 */
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
for (const cand of [process.env.SAG_ENV_FILE, path.join(ROOT, ".env"), path.join(ROOT, "..", "..", "..", ".env")]) {
  if (cand && existsSync(cand)) { loadEnv({ path: cand }); break; }
}
let dbReady = false;
try { await pool.query("select 1"); dbReady = true; } catch { dbReady = false; }
if (!dbReady) console.warn("[email-otp] 连不上数据库 —— 本组跳过（跑评测前请先起 docker compose up -d）");

/** 每个用例用独立邮箱 + 独立 IP, 免得互相踩限流桶 */
const tag = randomUUID().slice(0, 8);
const mail = (n: string) => `otp-${tag}-${n}@example.test`;
const ipTag = (n: string) => `test-ip-${tag}-${n}`;
const seededEmails: string[] = [];

/** 造一条码并**直接拿到明文** —— 生产路径不会把码返回给调用方, 这里靠测试钩子 */
async function issue(email: string, purpose: string, ip = "") {
  const r = await sendOtp({ email, purpose, ip, allowDevCode: true });
  seededEmails.push(email);
  return r;
}

beforeAll(async () => {
  if (!dbReady) return;
  await pool.query(`select count(*)::int c from email_otp_codes limit 1`);
}, 30_000);

afterAll(async () => {
  if (!dbReady) { await pool.end().catch(() => null); return; }
  // 只删本文件造的邮箱, 不动别人的数据
  for (const e of seededEmails) await pool.query(`delete from email_otp_codes where email = $1`, [e]).catch(() => null);
  await pool.query(`delete from email_otp_codes where email like $1`, [`otp-${tag}-%`]).catch(() => null);
  await pool.end().catch(() => null);
});

describe("① 纯函数: 码的生成与哈希(不连库也能跑)", () => {
  it("生成的码是 6 位数字, 且前导 0 不被吃掉", () => {
    for (let i = 0; i < 200; i++) {
      const c = generateOtpCode();
      expect(c).toMatch(/^\d{6}$/);
    }
  });

  it("生成的码有足够的随机性(2000 次里不同值远多于半数)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(generateOtpCode());
    expect(seen.size).toBeGreaterThan(1500);
  });

  it("哈希是自描述格式, 且同一码两次哈希不同(盐随机)", () => {
    const h1 = hashOtpCode("123456");
    const h2 = hashOtpCode("123456");
    expect(h1).toMatch(/^scrypt\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(h1).not.toBe(h2);
  });

  it("verifyOtpHash: 对的码通过, 错的码不通过", () => {
    const stored = hashOtpCode("042317");
    expect(verifyOtpHash("042317", stored)).toBe(true);
    expect(verifyOtpHash("042318", stored)).toBe(false);
    expect(verifyOtpHash("", stored)).toBe(false);
  });

  it("verifyOtpHash: 坏哈希(缺段/非 scrypt/空)一律不通过, 不抛异常", () => {
    for (const bad of ["", "abc", "scrypt$onlyone", "md5$aaa$bbb", "scrypt$$", "scrypt$!!!$!!!"]) {
      expect(verifyOtpHash("123456", bad)).toBe(false);
    }
  });

  it("邮箱归一与格式校验", () => {
    expect(normalizeEmail("  Foo@Example.COM ")).toBe("foo@example.com");
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail("  A@B.CO  ")).toBe(true);
    for (const bad of ["", "abc", "a@b", "@b.co", "a@.co", "a b@c.co"]) expect(isValidEmail(bad)).toBe(false);
  });

  it("用途白名单: 只认 register/reset/bind/login", () => {
    for (const p of ["register", "reset", "bind", "login"]) expect(isValidPurpose(p)).toBe(true);
    for (const p of ["", "admin", "REGISTER", "register2"]) expect(isValidPurpose(p)).toBe(false);
  });

  it("邮件正文含码与有效期, 且对 HTML 特殊字符转义", () => {
    const html = buildOtpEmailHtml("123456", "register", "SocioSeek");
    expect(html).toContain("123456");
    expect(html).toContain(String(OTP_TTL_MINUTES));
    const esc = buildOtpEmailHtml("<script>", "bind", "A & B");
    expect(esc).not.toContain("<script>");
    expect(esc).toContain("&amp;");
  });
});

describe.skipIf(!dbReady)("② 只存哈希: 明文码取不回来", () => {
  it("库里存的不是明文码, 而明文码能校验通过", async () => {
    const email = mail("hash");
    const sent = await issue(email, "register", ipTag("hash"));
    expect(sent.ok, JSON.stringify(sent)).toBe(true);
    expect(sent.devCode).toMatch(/^\d{6}$/);

    const row = await pool.query(`select code_hash from email_otp_codes where email=$1 order by created_at desc limit 1`, [email]);
    expect(row.rows.length).toBe(1);
    const stored = String(row.rows[0].code_hash);
    // 核心断言: 明文码**不在**库里
    expect(stored).not.toBe(sent.devCode);
    expect(stored).not.toContain(String(sent.devCode));
    expect(stored.startsWith("scrypt$")).toBe(true);

    const v = await verifyOtp({ email, code: sent.devCode!, purpose: "register" });
    expect(v.ok, v.error).toBe(true);
  });

  it("scrypt 哈希不是快哈希: 每次生成耗时明显高于 sha256(拖库后难爆破)", () => {
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) hashOtpCode("123456");
    const perHash = (Date.now() - t0) / 5;
    // 太慢也不行(会拖垮校验路径), 给一个宽区间
    expect(perHash).toBeGreaterThan(1);
    expect(perHash).toBeLessThan(3000);
  });
});

describe.skipIf(!dbReady)("③ 一次性: 校验成功即作废", () => {
  it("同一个码用第二次失败", async () => {
    const email = mail("once");
    const sent = await issue(email, "register", ipTag("once"));
    const first = await verifyOtp({ email, code: sent.devCode!, purpose: "register" });
    expect(first.ok, first.error).toBe(true);
    const second = await verifyOtp({ email, code: sent.devCode!, purpose: "register" });
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/不存在|失效/);
  });

  it("consumed_at 被写上(不是把行删掉 —— 保留审计痕迹)", async () => {
    const email = mail("consumed");
    const sent = await issue(email, "reset", ipTag("consumed"));
    await verifyOtp({ email, code: sent.devCode!, purpose: "reset" });
    const row = await pool.query(`select consumed_at from email_otp_codes where email=$1`, [email]);
    expect(row.rows[0]?.consumed_at).not.toBeNull();
  });

  it("重发会让旧码立即失效(用户手里不会同时有两个有效码)", async () => {
    const email = mail("resend");
    const first = await issue(email, "register", ipTag("resend"));
    // 绕过 60 秒重发限流: 直接把刚才那条的时间往前拨
    await pool.query(`update email_otp_codes set created_at = created_at - interval '2 minutes' where email=$1`, [email]);
    const second = await issue(email, "register", ipTag("resend"));
    expect(second.ok, JSON.stringify(second)).toBe(true);
    expect(second.devCode).not.toBe(first.devCode);

    const oldCode = await verifyOtp({ email, code: first.devCode!, purpose: "register" });
    expect(oldCode.ok, "旧码居然还能用 —— 用户手里会同时存在两个有效码").toBe(false);
    const newCode = await verifyOtp({ email, code: second.devCode!, purpose: "register" });
    expect(newCode.ok, newCode.error).toBe(true);
  });
});

describe.skipIf(!dbReady)("④ 试错上限: 5 次后立即作废", () => {
  it("连续错 5 次后作废, 且第 6 次即使填对也不通过", async () => {
    const email = mail("attempts");
    const sent = await issue(email, "register", ipTag("attempts"));
    const wrong = String((Number(sent.devCode) + 1) % 1000000).padStart(6, "0");

    for (let i = 1; i <= OTP_MAX_ATTEMPTS; i++) {
      const r = await verifyOtp({ email, code: wrong, purpose: "register" });
      expect(r.ok).toBe(false);
      if (i < OTP_MAX_ATTEMPTS) {
        expect(r.error).toMatch(/还可尝试/);
        expect(r.attemptsLeft).toBe(OTP_MAX_ATTEMPTS - i);
      }
    }
    const after = await verifyOtp({ email, code: sent.devCode!, purpose: "register" });
    expect(after.ok, "超过上限后, 正确的码也不该再被接受").toBe(false);
    expect(after.error).toMatch(/次数过多|不存在|失效/);
  });

  it("attempts 落库, 不是只记在内存", async () => {
    const email = mail("attemptsdb");
    const sent = await issue(email, "register", ipTag("attemptsdb"));
    const wrong = String((Number(sent.devCode) + 5) % 1000000).padStart(6, "0");
    await verifyOtp({ email, code: wrong, purpose: "register" });
    const row = await pool.query(`select attempts from email_otp_codes where email=$1`, [email]);
    expect(Number(row.rows[0]?.attempts)).toBe(1);
  });
});

describe.skipIf(!dbReady)("⑤ 用途隔离: 注册的码改不了密码", () => {
  it("register 的码拿去 reset 场景不通过", async () => {
    const email = mail("purpose");
    const sent = await issue(email, "register", ipTag("purpose"));
    const cross = await verifyOtp({ email, code: sent.devCode!, purpose: "reset" });
    expect(cross.ok, "跨用途的码被接受了 —— 这是验证码类功能最常见的越权口子").toBe(false);
    expect(cross.error).toMatch(/不存在|失效/);
    // 原用途仍然可用(错用不该把码烧掉)
    const own = await verifyOtp({ email, code: sent.devCode!, purpose: "register" });
    expect(own.ok, own.error).toBe(true);
  });

  it("绑定邮箱的码不能用于登录", async () => {
    const email = mail("purpose2");
    const sent = await issue(email, "bind", ipTag("purpose2"));
    expect((await verifyOtp({ email, code: sent.devCode!, purpose: "login" })).ok).toBe(false);
    expect((await verifyOtp({ email, code: sent.devCode!, purpose: "bind" })).ok).toBe(true);
  });

  it("非法用途被拒(发送与校验都拒)", async () => {
    const email = mail("badpurpose");
    const sent = await sendOtp({ email, purpose: "admin", ip: ipTag("badpurpose"), allowDevCode: true });
    expect(sent.ok).toBe(false);
    expect(sent.code).toBe("invalid_purpose");
    const v = await verifyOtp({ email, code: "123456", purpose: "admin" });
    expect(v.ok).toBe(false);
  });
});

describe.skipIf(!dbReady)("⑥ 发送限流", () => {
  it("同邮箱 60 秒内只能发一次", async () => {
    const email = mail("rl60");
    const first = await issue(email, "register", ipTag("rl60"));
    expect(first.ok, JSON.stringify(first)).toBe(true);
    const second = await sendOtp({ email, purpose: "register", ip: ipTag("rl60"), allowDevCode: true });
    expect(second.ok).toBe(false);
    expect(second.code).toBe("rate_limited");
    expect(second.retryAfterSeconds).toBeGreaterThan(0);
    expect(second.retryAfterSeconds).toBeLessThanOrEqual(OTP_RESEND_WINDOW_SECONDS);
  });

  it("限流是按邮箱的: 换个邮箱立刻能发(证明不是全局锁)", async () => {
    const a = mail("rlA");
    const b = mail("rlB");
    expect((await issue(a, "register", ipTag("rlA"))).ok).toBe(true);
    const r = await sendOtp({ email: b, purpose: "register", ip: ipTag("rlB"), allowDevCode: true });
    seededEmails.push(b);
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it("同邮箱 1 小时上限: 把时间往前拨后仍会在第 6 次被拦", async () => {
    const email = mail("rlhour");
    for (let i = 0; i < OTP_EMAIL_HOURLY_LIMIT; i++) {
      const r = await issue(email, "register", ipTag("rlhour"));
      expect(r.ok, `第 ${i + 1} 次应当放行: ${JSON.stringify(r)}`).toBe(true);
      // 每次把刚写的记录挪出 60 秒窗口, 专测小时桶
      await pool.query(`update email_otp_codes set created_at = created_at - interval '70 seconds' where email=$1`, [email]);
    }
    const over = await sendOtp({ email, purpose: "register", ip: ipTag("rlhour"), allowDevCode: true });
    expect(over.ok).toBe(false);
    expect(over.code).toBe("rate_limited");
  });

  it("同 IP 1 小时上限: 换邮箱也拦得住(防换地址刷同一个人)", async () => {
    const ip = ipTag("iphour");
    for (let i = 0; i < OTP_IP_HOURLY_LIMIT; i++) {
      const email = mail(`ip${i}`);
      const r = await issue(email, "register", ip);
      expect(r.ok, `第 ${i + 1} 个邮箱应当放行: ${JSON.stringify(r)}`).toBe(true);
      await pool.query(`update email_otp_codes set created_at = created_at - interval '70 seconds' where email=$1`, [email]);
    }
    const over = await sendOtp({ email: mail("ipover"), purpose: "register", ip, allowDevCode: true });
    expect(over.ok).toBe(false);
    expect(over.code).toBe("rate_limited");
    expect(over.error).toMatch(/网络|上限/);
  });

  it("发送失败(未配置 SMTP)不留占位记录 —— 否则用户会被自己没收到的那条限流 60 秒", async () => {
    const email = mail("nosmtp");
    seededEmails.push(email);
    const cfgBackup = { host: process.env.SMTP_HOST, user: process.env.SMTP_USER, pass: process.env.SMTP_PASS };
    const saved = { ...cfgBackup };
    delete process.env.SMTP_HOST; delete process.env.SMTP_USER; delete process.env.SMTP_PASS;
    try {
      /**
       * ⚠ `allowDevCode: false` **必须显式传**。
       *
       * 它默认是 undefined, 而 `allowDevCode()` 在 undefined 时会回落到
       * `NODE_ENV === "test"` —— vitest 下正好是 test, 于是这条会拿到 devCode
       * 而返回 ok:true, "发送失败"这个前提根本没成立, 判据也就测不到东西。
       * (实测就是这么红的第一版。)
       */
      const r = await sendOtp({ email, purpose: "register", ip: ipTag("nosmtp"), allowDevCode: false });
      expect(r.ok).toBe(false);
      expect(r.code).toBe("smtp");
      const rows = await pool.query(`select count(*)::int c from email_otp_codes where email=$1`, [email]);
      expect(Number(rows.rows[0].c)).toBe(0);
    } finally {
      if (saved.host) process.env.SMTP_HOST = saved.host;
      if (saved.user) process.env.SMTP_USER = saved.user;
      if (saved.pass) process.env.SMTP_PASS = saved.pass;
    }
  });

  /**
   * 未配置 SMTP + 允许 devCode 这条分支**必须把行留下**。
   *
   * ⚠ 第一版是"返回 devCode 前把刚插的行删掉", 看着更干净, 实际后果是:
   *   开发/测试模式下库里一行都没有 ⇒ "只存哈希""一次性""用途隔离""试错上限"
   *   这些性质**在测试里全部没被真正验证** —— 测试全绿只证明了一条被删干净的路径。
   *   (这条测试就是那次踩坑留下的哨兵。)
   */
  it("未配置 SMTP + devCode 模式下: 码仍然落库, 于是后续性质真的可被验证", async () => {
    const email = mail("devcode");
    seededEmails.push(email);
    const saved = { h: process.env.SMTP_HOST, u: process.env.SMTP_USER, p: process.env.SMTP_PASS };
    delete process.env.SMTP_HOST; delete process.env.SMTP_USER; delete process.env.SMTP_PASS;
    try {
      const r = await sendOtp({ email, purpose: "register", ip: ipTag("devcode"), allowDevCode: true });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(r.devCode).toMatch(/^\d{6}$/);
      const rows = await pool.query(`select count(*)::int c from email_otp_codes where email=$1`, [email]);
      expect(Number(rows.rows[0].c), "devCode 模式下把行删掉了 —— 于是这条链上的安全性质全都验不到").toBe(1);
      // 而且它真的能用(否则"落库"只是摆样子)
      const v = await verifyOtp({ email, code: r.devCode!, purpose: "register" });
      expect(v.ok, v.error).toBe(true);
    } finally {
      if (saved.h) process.env.SMTP_HOST = saved.h;
      if (saved.u) process.env.SMTP_USER = saved.u;
      if (saved.p) process.env.SMTP_PASS = saved.p;
    }
  });

  it("未配置 SMTP 且不给 devCode: 明确报邮件服务未配置, 不是含糊的失败", async () => {
    const email = mail("nosmtp2");
    seededEmails.push(email);
    const saved = { h: process.env.SMTP_HOST, u: process.env.SMTP_USER, p: process.env.SMTP_PASS };
    delete process.env.SMTP_HOST; delete process.env.SMTP_USER; delete process.env.SMTP_PASS;
    try {
      const r = await sendOtp({ email, purpose: "reset", ip: ipTag("nosmtp2"), allowDevCode: false });
      expect(r.ok).toBe(false);
      expect(r.code).toBe("smtp");
      expect(r.error).toMatch(/未配置|SMTP/);
    } finally {
      if (saved.h) process.env.SMTP_HOST = saved.h;
      if (saved.u) process.env.SMTP_USER = saved.u;
      if (saved.p) process.env.SMTP_PASS = saved.p;
    }
  });
});

describe.skipIf(!dbReady)("⑨ 并发: 上限与一次性在并发下不被放大", () => {
  /**
   * ⚠ 并发是这类"计数式"安全机制的经典失效点: 五个请求同时读到 attempts=0,
   *   各自加 1 写回, 结果只记了 1 次 —— 上限被放大成并发数倍。
   *   实现用 `for update` 行锁 + 单条原子 UPDATE 兜住, 这条测试就是盯它。
   */
  it("并发提交 5 个错误码: 只应记 5 次失败, 且码在达到上限后作废", async () => {
    const email = mail("concurrent");
    const sent = await issue(email, "register", ipTag("concurrent"));
    const wrong = String((Number(sent.devCode) + 7) % 1000000).padStart(6, "0");
    const results = await Promise.all(
      Array.from({ length: OTP_MAX_ATTEMPTS + 2 }, () => verifyOtp({ email, code: wrong, purpose: "register" })),
    );
    expect(results.every((r) => !r.ok)).toBe(true);
    const row = await pool.query(`select attempts, consumed_at from email_otp_codes where email=$1`, [email]);
    const attempts = Number(row.rows[0]?.attempts ?? 0);
    expect(attempts, "并发下失败计数被吞了 —— 上限等于没有").toBe(OTP_MAX_ATTEMPTS);
    expect(row.rows[0]?.consumed_at, "触到上限却没有作废").not.toBeNull();
  });

  it("并发提交正确的码: 只能有 1 个成功(一次性在并发下也要成立)", async () => {
    const email = mail("onceconc");
    const sent = await issue(email, "register", ipTag("onceconc"));
    const results = await Promise.all(
      Array.from({ length: 4 }, () => verifyOtp({ email, code: sent.devCode!, purpose: "register" })),
    );
    const okCount = results.filter((r) => r.ok).length;
    expect(okCount, "同一个码被并发校验通过了多次 —— 一次性失效").toBe(1);
  });
});

describe.skipIf(!dbReady)("⑦ 过期与清理", () => {
  it("过期的码不通过, 并给出可读原因", async () => {
    const email = mail("expired");
    const sent = await issue(email, "register", ipTag("expired"));
    // 把有效期拨到过去
    await pool.query(`update email_otp_codes set expires_at = now() - interval '1 second' where email=$1`, [email]);
    const v = await verifyOtp({ email, code: sent.devCode!, purpose: "register" });
    expect(v.ok).toBe(false);
    expect(v.code).toBe("expired");
    expect(v.error).toMatch(/过期/);
  });

  it("默认 TTL 是 5 分钟, 与常量一致", async () => {
    const email = mail("ttl");
    const sent = await issue(email, "register", ipTag("ttl"));
    expect(sent.expiresInSeconds).toBe(OTP_TTL_MINUTES * 60);
    const row = await pool.query(`select extract(epoch from (expires_at - created_at))::int as ttl from email_otp_codes where email=$1`, [email]);
    expect(Number(row.rows[0].ttl)).toBe(OTP_TTL_MINUTES * 60);
  });

  it("cleanupExpiredOtps 删掉老记录, 留下新记录", async () => {
    const email = mail("cleanup");
    const sent = await issue(email, "register", ipTag("cleanup"));
    expect(sent.ok, JSON.stringify(sent)).toBe(true);
    // 老记录: 过期很久且已消费
    await pool.query(
      `update email_otp_codes set expires_at = now() - interval '48 hours', consumed_at = now() - interval '48 hours' where email=$1`,
      [email]);
    const removed = await cleanupExpiredOtps(24);
    expect(removed).toBeGreaterThanOrEqual(1);
    const left = await pool.query(`select count(*)::int c from email_otp_codes where email=$1`, [email]);
    expect(Number(left.rows[0].c)).toBe(0);
  });

  it("刚发出来还没过期的记录不会被清理", async () => {
    const email = mail("keepalive");
    await issue(email, "register", ipTag("keepalive"));
    await cleanupExpiredOtps(24);
    const left = await pool.query(`select count(*)::int c from email_otp_codes where email=$1`, [email]);
    expect(Number(left.rows[0].c)).toBe(1);
  });
});

describe.skipIf(!dbReady)("⑧ 失败路径给出可读原因, 不是静默 false", () => {
  it("不存在的邮箱: 说清楚要重新获取, 不泄露该邮箱是否存在", async () => {
    const v = await verifyOtp({ email: mail("never"), code: "123456", purpose: "register" });
    expect(v.ok).toBe(false);
    expect(v.code).toBe("not_found");
    expect(v.error).toMatch(/不存在|失效|重新获取/);
    expect(v.error, "错误里不该出现内部栈或 undefined").not.toMatch(/at \w+ \(|undefined/);
  });

  it("码格式不对(长度/非数字)直接判否, 不打库", async () => {
    for (const code of ["", "12345", "1234567", "abcdef", "12 34 56"]) {
      const v = await verifyOtp({ email: mail("format"), code, purpose: "register" });
      expect(v.ok).toBe(false);
      expect(v.code).toBe("not_found");
    }
  });

  it("邮箱格式不对时也返回可读错误", async () => {
    const v = await verifyOtp({ email: "not-an-email", code: "123456", purpose: "register" });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/邮箱/);
  });

  it("sendOtp 对坏邮箱与坏用途分别给出专门的 code", async () => {
    const bad = await sendOtp({ email: "nope", purpose: "register", allowDevCode: true });
    expect(bad.code).toBe("invalid_email");
    const badPurpose = await sendOtp({ email: mail("x"), purpose: "whatever", allowDevCode: true });
    expect(badPurpose.code).toBe("invalid_purpose");
  });

  it("inspectActiveOtp 能看见元信息, 但拿不到码(它本来就取不出来)", async () => {
    const email = mail("inspect");
    const sent = await issue(email, "register", ipTag("inspect"));
    const info = await inspectActiveOtp(email, "register");
    expect(info).toBeTruthy();
    expect(String(info.created_at)).toBeTruthy();
    expect(JSON.stringify(info)).not.toContain(sent.devCode!);
  });
});
