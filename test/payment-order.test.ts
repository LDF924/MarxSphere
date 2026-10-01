/**
 * payment-order.test.ts — 支付链路的正确性(2026-10-01)。
 *
 * 由来: 本项目此前**没有订单这一层**, `POST /api/billing/recharge` 直接加余额、
 *   不需要任何支付。补上真链路后, 正确性全压在三条不变量上, 这个文件就盯它们:
 *
 *   ① **只有真收款才加钱** —— 且加钱与置 paid 在同一事务
 *   ② **同一渠道流水只入账一次** —— 微信会重推回调(5s/10s/30s...), 不幂等就加 N 次钱
 *   ③ **金额必须二次核对** —— 防"改价攻击"(1 分钱的支付去确认 100 元的订单)
 *
 * 分工:
 *   · 不连库的部分(验签/解密/防重放)在这里真跑 —— 它们是**密码学层**的安全边界
 *   · 连库的部分(入账/退款/超时)用 describe.skipIf, 学 file-text-service.test.ts
 *   · 剩下的用**源码级判据**守住"删不掉"的语义(例如那三条不变量不能被改回去)
 *
 * ⚠ 判据自证: 每条关键断言都要求它**能看到被测对象**。本仓库有过教训 ——
 *   判据写在注释上、或只查字符串不看调用, 都会变成恒真的假通过。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPairSync, createSign, createCipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAY_SRC = fs.readFileSync(path.join(ROOT, "src/services/wechat-pay-service.ts"), "utf8");
const ORDER_SRC = fs.readFileSync(path.join(ROOT, "src/services/payment-order-service.ts"), "utf8");
const MIGRATION = fs.readFileSync(path.join(ROOT, "migrations/166_payment_orders.sql"), "utf8");

// ════════════════════ 密码学层(不需要 DB) ════════════════════

/**
 * 造一对 RSA 密钥当"商户私钥/平台公钥"。
 *
 * ⚠ `createVerify().verify()` 的 key 参数**既能接证书也能接裸公钥 PEM** ——
 *   所以这里不用真去签一张 X.509 证书(那要 openssl), 直接喂公钥即可。
 *   这是"能真跑"与"只能 skip"的分界: 验签的逻辑路径被真实覆盖了。
 */
const { privateKey: mchKey, publicKey: platformPubKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const API_V3_KEY = "0123456789abcdef0123456789abcdef"; // 32 字节

beforeAll(async () => {
  // 把配置塞进 env 再导入服务 —— loadConfig 有缓存, 所以要在导入前设好
  process.env.WXPAY_MCH_ID = "1900000000";
  process.env.WXPAY_SERIAL_NO = "TESTSERIAL";
  process.env.WXPAY_PRIVATE_KEY = String(mchKey).replace(/\n/g, "\\n"); // 顺带验转义还原
  process.env.WXPAY_APIV3_KEY = API_V3_KEY;
  process.env.WXPAY_PLATFORM_CERT = String(platformPubKey);
  process.env.WXPAY_NOTIFY_URL = "https://example.com/api/pay/notify/wechat";
  const svc = await import("../src/services/wechat-pay-service.js");
  svc.resetPayConfigCache();
});

describe("微信支付: 回调验签", () => {
  it("**正确签名通过** —— 用平台公钥对 (时间戳\\n随机串\\n包体\\n) 验", async () => {
    const { verifyNotifySignature } = await import("../src/services/wechat-pay-service.js");
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = "abc123";
    const body = JSON.stringify({ id: "evt-1", event_type: "TRANSACTION.SUCCESS" });
    const signature = createSign("RSA-SHA256")
      .update(`${ts}\n${nonce}\n${body}\n`).sign(mchKey, "base64");

    const r = await verifyNotifySignature({ timestamp: ts, nonce, signature, body });
    expect(r.ok, `验签失败: ${r.error}`).toBe(true);
  });

  it("**签名被改一个字节就拒绝**(不能是「验了但没验出问题」)", async () => {
    const { verifyNotifySignature } = await import("../src/services/wechat-pay-service.js");
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ event_type: "TRANSACTION.SUCCESS" });
    const good = createSign("RSA-SHA256")
      .update(`${ts}\nn1\n${body}\n`).sign(mchKey, "base64");
    // 翻转一处
    const bad = good.slice(0, 10) + (good[10] === "A" ? "B" : "A") + good.slice(11);

    const r = await verifyNotifySignature({ timestamp: ts, nonce: "n1", signature: bad, body });
    expect(r.ok).toBe(false);
  });

  it("**包体被篡改就拒绝**(签名只对原包体有效 —— 这条挡住「改成我的订单号」)", async () => {
    const { verifyNotifySignature } = await import("../src/services/wechat-pay-service.js");
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = "n2";
    const original = JSON.stringify({ out_trade_no: "SS-REAL", amount: { total: 100 } });
    const signature = createSign("RSA-SHA256")
      .update(`${ts}\n${nonce}\n${original}\n`).sign(mchKey, "base64");

    // 攻击者保留签名, 只把包体换成自己的订单
    const tampered = JSON.stringify({ out_trade_no: "SS-ATTACKER", amount: { total: 999999 } });
    const r = await verifyNotifySignature({ timestamp: ts, nonce, signature, body: tampered });
    expect(r.ok).toBe(false);
  });

  it("**时间戳过旧就拒绝**(防重放 —— 否则偷到一个合法回调可无限重发)", async () => {
    const { verifyNotifySignature } = await import("../src/services/wechat-pay-service.js");
    const old = String(Math.floor(Date.now() / 1000) - 3600); // 1 小时前
    const nonce = "n3";
    const body = "{}";
    const signature = createSign("RSA-SHA256")
      .update(`${old}\n${nonce}\n${body}\n`).sign(mchKey, "base64");

    const r = await verifyNotifySignature({ timestamp: old, nonce, signature, body });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("重放");
  });

  it("缺验签头直接拒绝", async () => {
    const { verifyNotifySignature } = await import("../src/services/wechat-pay-service.js");
    const r = await verifyNotifySignature({ body: "{}" });
    expect(r.ok).toBe(false);
  });
});

describe("微信支付: 回调解密(AES-256-GCM)", () => {
  /** 按微信的格式造一段密文: 明文 + 16 字节 authTag 尾接, base64 */
  function encryptWechatStyle(plain: string, key: string, nonce: string, aad: string): string {
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "utf8"), Buffer.from(nonce, "utf8"));
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return Buffer.concat([enc, cipher.getAuthTag()]).toString("base64");
  }

  it("**能解出明文**(不接这一步就只能拿到密文, 等于没接回调)", async () => {
    const { decryptNotifyResource } = await import("../src/services/wechat-pay-service.js");
    const payload = JSON.stringify({ out_trade_no: "SS20260101000001ABC", amount: { total: 1990 } });
    const ciphertext = encryptWechatStyle(payload, API_V3_KEY, "nonce1234567", "transaction");

    const r = await decryptNotifyResource({ ciphertext, nonce: "nonce1234567", associated_data: "transaction" });
    expect(r.ok, `解密失败: ${r.error}`).toBe(true);
    expect(r.data?.out_trade_no).toBe("SS20260101000001ABC");
    // 解出来的是对象而不是字符串
    expect((r.data?.amount as { total?: number })?.total).toBe(1990);
  });

  it("**改密文一个字节 → GCM 校验失败**(不能解出垃圾还当成功)", async () => {
    const { decryptNotifyResource } = await import("../src/services/wechat-pay-service.js");
    const ciphertext = encryptWechatStyle(JSON.stringify({ a: 1 }), API_V3_KEY, "nonce1234567", "transaction");
    const raw = Buffer.from(ciphertext, "base64");
    raw[5] = raw[5] ^ 0xff;
    const r = await decryptNotifyResource({
      ciphertext: raw.toString("base64"), nonce: "nonce1234567", associated_data: "transaction",
    });
    expect(r.ok).toBe(false);
  });

  it("**AAD 不匹配 → 失败**(AAD 是 GCM 的一部分, 不校验等于少一道)", async () => {
    const { decryptNotifyResource } = await import("../src/services/wechat-pay-service.js");
    const ciphertext = encryptWechatStyle(JSON.stringify({ a: 1 }), API_V3_KEY, "nonce1234567", "transaction");
    const r = await decryptNotifyResource({
      ciphertext, nonce: "nonce1234567", associated_data: "WRONG",
    });
    expect(r.ok).toBe(false);
  });
});

// ════════════════════ 不变量(源码级, 守住"不能被改回去") ════════════════════

describe("三条支付不变量不许回退(源码级)", () => {
  it("**金额核对必须在**(防改价攻击)", () => {
    // 判据: 要看到真实的比较与拒绝分支, 不是一句注释
    expect(ORDER_SRC).toMatch(/paidAmountCents\s*!==\s*order\.amountCents/);
    const idx = ORDER_SRC.indexOf("paidAmountCents !== order.amountCents");
    const after = ORDER_SRC.slice(idx, idx + 400);
    expect(after, "核对之后必须拒绝入账(有回滚与 return false)").toMatch(/rollback|return\s*\{\s*ok:\s*false/);
  });

  it("**入账幂等**: 已 paid 的订单直接返回 duplicate, 不重复加钱", () => {
    expect(ORDER_SRC).toMatch(/status === "paid"[\s\S]{0,200}?duplicate:\s*true/);
  });

  it("**加钱与置 paid 在同一事务**(begin/commit 且中间有 creditUser)", () => {
    const begin = ORDER_SRC.indexOf('await client.query("begin")');
    const commit = ORDER_SRC.indexOf('await client.query("commit")');
    const credit = ORDER_SRC.indexOf("await creditUser(");
    expect(begin, "没有 begin").toBeGreaterThan(-1);
    expect(commit, "没有 commit").toBeGreaterThan(-1);
    expect(credit, "没有调用 creditUser").toBeGreaterThan(-1);
    expect(credit, "creditUser 必须在 begin 与 commit 之间").toBeGreaterThan(begin);
    expect(credit, "creditUser 必须在 begin 与 commit 之间").toBeLessThan(commit);
  });

  it("**退款不得超过实收**", () => {
    expect(ORDER_SRC).toMatch(/already\s*\+\s*want\s*>\s*order\.amountCents/);
  });

  it("**回调必须验签 + 解密 + 核对金额** —— 三步都在回调路由里", () => {
    const server = fs.readFileSync(path.join(ROOT, "src/api/server.ts"), "utf8");
    /**
     * ⚠ 必须定位到**路由注册**那一处, 不能只搜 `"/api/pay/notify/wechat"`。
     *
     * 第一版就是这么写的, 结果 indexOf 命中白名单里的那一行 —— 切片拿到的是白名单,
     * 自然不含 verifyNotifySignature, 于是判据报红而**被测对象根本没被看到**。
     * 这正是本仓库反复记录的"判据看不到被测对象"那一类: 判据自己坏了, 看着却像代码有问题。
     */
    const i = server.indexOf('app.post("/api/pay/notify/wechat"');
    expect(i, "找不到回调路由的注册处").toBeGreaterThan(-1);
    const handler = server.slice(i, i + 3000);
    expect(handler, "回调没验签").toContain("verifyNotifySignature");
    expect(handler, "回调没解密").toContain("decryptNotifyResource");
    expect(handler, "回调没把渠道金额传给入账函数(那样就核不了额)").toMatch(/paidAmountCents/);
  });

  it("**回调路由在免鉴权白名单里** —— 不在的话公网微信会被 401 挡掉", () => {
    const server = fs.readFileSync(path.join(ROOT, "src/api/server.ts"), "utf8");
    const i = server.indexOf("const AUTH_WHITELIST");
    const block = server.slice(i, server.indexOf("]);", i));
    expect(block, "回调不在白名单 —— 部署到公网后微信永远回调失败").toContain("/api/pay/notify/wechat");
  });

  it("**手工调账已收紧**(此前它 = 任意用户自助充值)", () => {
    const server = fs.readFileSync(path.join(ROOT, "src/api/server.ts"), "utf8");
    const i = server.indexOf('"/api/billing/recharge"');
    const handler = server.slice(i, i + 1200);
    expect(handler, "billing/recharge 又能随便加了").toMatch(/isLocalRequest|role\s*!==\s*"admin"/);
  });
});

// ════════════════════ 迁移层 ════════════════════

describe("订单表: 幂等靠约束兜底, 不靠代码自觉", () => {
  it("渠道流水号有唯一索引(并发重推时数据库挡住第二条)", () => {
    expect(MIGRATION).toMatch(/UNIQUE INDEX[\s\S]{0,120}payment_orders\s*\(\s*provider\s*,\s*transaction_id\s*\)/);
  });

  it("订单号唯一 + 幂等键按用户唯一", () => {
    expect(MIGRATION).toMatch(/out_trade_no\s+text NOT NULL UNIQUE/);
    expect(MIGRATION).toMatch(/UNIQUE INDEX[\s\S]{0,120}payment_orders\s*\(\s*user_id\s*,\s*idem_key\s*\)/);
  });

  it("金额是 bigint 且有正数约束(钱不能用浮点)", () => {
    expect(MIGRATION).toMatch(/amount_cents\s+bigint NOT NULL CHECK \(amount_cents > 0\)/);
    expect(MIGRATION, "不许出现 float/numeric 存金额").not.toMatch(/amount_cents\s+(float|double|numeric|real)/i);
  });

  it("退款表对订单有外键(订单删了退款记录不该变孤儿)", () => {
    expect(MIGRATION).toMatch(/order_id\s+uuid NOT NULL REFERENCES payment_orders\(id\)/);
  });

  it("迁移幂等(可重复执行)", () => {
    // 每个 create 都要带 if not exists
    const creates = [...MIGRATION.matchAll(/^\s*CREATE\s+(TABLE|UNIQUE INDEX|INDEX)\s+(?!IF NOT EXISTS)/gim)];
    expect(creates.map((m) => m[0].trim()), "有非幂等的 CREATE").toEqual([]);
  });
});

// ════════════════════ 连库端到端(skipIf) ════════════════════

const { pool } = await import("../src/db/pool.js");
let dbReady = false;
try { await pool.query("select 1"); dbReady = true; } catch { dbReady = false; }
if (!dbReady) {
  console.warn("[payment-order] 连不上数据库 —— 端到端整组跳过（先 docker compose up -d + db:migrate）");
}

describe.skipIf(!dbReady)("订单端到端: 下单 → 入账 → 退款", () => {
  let userId = "";
  let outTradeNo = "";

  /**
   * ⚠ 这里必须把支付配置**清干净**, 让服务落回 mock 模式。
   *
   * 上面那组密码学测试往 env 塞了真密钥(它需要真密钥才能验签), 而支付服务的配置
   * 是**模块级缓存**的 —— 不隔离的话, 本组的 createOrder 会拿那套假凭证去
   * **真打微信线上接口**, 报 401 SIGN_ERROR。实测就是这样: 端到端全挂在一个
   * 与业务无关的 401 上, 看着像"下单逻辑坏了"。
   */
  beforeAll(async () => {
    for (const k of ["WXPAY_MCH_ID", "WXPAY_SERIAL_NO", "WXPAY_PRIVATE_KEY",
                     "WXPAY_APIV3_KEY", "WXPAY_PLATFORM_CERT", "WXPAY_NOTIFY_URL"]) {
      delete process.env[k];
    }
    // 配置也可能来自库里这张表(wechat-auth 那套约定), 一并清掉
    try { await pool.query(`delete from ai_provider_settings where key='wechat_pay'`); }
    catch { /* 表未就绪 */ }
    const svc = await import("../src/services/wechat-pay-service.js");
    svc.resetPayConfigCache();
    expect(await svc.isPayMockMode(), "配置没清干净 —— 会去打真微信接口").toBe(true);
  });

  it("下单拿到二维码占位(mock 模式)", async () => {
    const { createOrder } = await import("../src/services/payment-order-service.js");
    // users 有 username / tenant_id 两个 NOT NULL(见迁移 043), 建测试用户时都要给
    const tenant = await pool.query(
      `insert into tenants (type, name) values ('single', $1) returning id`,
      [`pay-test-tenant-${Date.now()}`]);
    const tenantId = String(tenant.rows[0].id);
    const u = await pool.query(
      `insert into users (username, password_hash, tenant_id) values ($1, 'x', $2) returning id`,
      [`paytest_${Date.now()}`, tenantId]);
    userId = String(u.rows[0].id);

    const r = await createOrder({ userId, amountCents: 1990, subject: "测试充值" });
    expect(r.ok, `下单失败: ${r.error}`).toBe(true);
    expect(r.order?.status).toBe("pending");
    expect(r.order?.amountCents).toBe(1990);
    outTradeNo = r.order!.outTradeNo;
  });

  it("**金额不符 → 拒绝入账**(改价攻击的正面测试)", async () => {
    const { settleOrder, getOrder } = await import("../src/services/payment-order-service.js");
    const bad = await settleOrder({
      outTradeNo, transactionId: `txn-bad-${Date.now()}`, paidAmountCents: 1,
    });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("金额不符");
    expect((await getOrder(outTradeNo))?.status, "拒绝后订单不该被改成已付").toBe("pending");
  });

  it("金额相符 → 入账成功, 余额增加", async () => {
    const { settleOrder } = await import("../src/services/payment-order-service.js");
    const before = Number((await pool.query(
      `select balance_cents from users where id=$1`, [userId])).rows[0]?.balance_cents ?? 0);

    const r = await settleOrder({
      outTradeNo, transactionId: `txn-ok-${Date.now()}`, paidAmountCents: 1990,
    });
    expect(r.ok, `入账失败: ${r.error}`).toBe(true);
    expect(r.creditedCents).toBe(1990);

    const after = Number((await pool.query(
      `select balance_cents from users where id=$1`, [userId])).rows[0].balance_cents);
    expect(after - before).toBe(1990);
  });

  it("**同一流水重复入账 → duplicate, 余额不再增加**(微信会重推)", async () => {
    const { settleOrder, getOrder } = await import("../src/services/payment-order-service.js");
    const order = await getOrder(outTradeNo);
    const txn = order!.transactionId!;
    const before = Number((await pool.query(
      `select balance_cents from users where id=$1`, [userId])).rows[0].balance_cents);

    const again = await settleOrder({ outTradeNo, transactionId: txn, paidAmountCents: 1990 });
    expect(again.ok).toBe(true);
    expect(again.duplicate).toBe(true);

    const after = Number((await pool.query(
      `select balance_cents from users where id=$1`, [userId])).rows[0].balance_cents);
    expect(after, "重复回调加了两次钱 —— 这是资损").toBe(before);
  });

  it("**退款超额被拒**", async () => {
    const { refundOrder } = await import("../src/services/payment-order-service.js");
    const r = await refundOrder({ outTradeNo, amountCents: 999_999 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("超额");
  });

  it("退款成功且余额扣回", async () => {
    const { refundOrder } = await import("../src/services/payment-order-service.js");
    const before = Number((await pool.query(
      `select balance_cents from users where id=$1`, [userId])).rows[0].balance_cents);
    const r = await refundOrder({ outTradeNo, amountCents: 1990, reason: "测试退款" });
    expect(r.ok, `退款失败: ${r.error}`).toBe(true);
    const after = Number((await pool.query(
      `select balance_cents from users where id=$1`, [userId])).rows[0].balance_cents);
    expect(after - before).toBe(-1990);
  });

  it("超时关单只关 pending/created", async () => {
    const { closeExpiredOrders, getOrder } = await import("../src/services/payment-order-service.js");
    await pool.query(
      `update payment_orders set expire_at = now() - interval '1 hour' where out_trade_no=$1`,
      [outTradeNo]);
    await closeExpiredOrders();
    // 已退款的单不该被改成 closed
    expect((await getOrder(outTradeNo))?.status).not.toBe("closed");
  });

  it("清理测试数据", async () => {
    await pool.query(`delete from payment_refunds where order_id in
      (select id from payment_orders where user_id=$1)`, [userId]);
    await pool.query(`delete from payment_orders where user_id=$1`, [userId]);
    await pool.query(`delete from recharges where user_id=$1`, [userId]);
    await pool.query(`delete from billing_records where user_id=$1`, [userId]);
    const t = await pool.query(`select tenant_id from users where id=$1`, [userId]);
    await pool.query(`delete from users where id=$1`, [userId]);
    if (t.rows[0]) await pool.query(`delete from tenants where id=$1`, [t.rows[0].tenant_id]);
    expect(true).toBe(true);
  });
});
