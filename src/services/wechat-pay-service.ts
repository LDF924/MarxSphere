// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// wechat-pay-service.ts — 微信支付 v3(Native 扫码) + 回调验签 + 退款(2026-10-01)
//
// 由来: 复盘旧项目 AItoolman 时发现它有一整条收款链路(`请使用微信扫码支付` /
//   `请生成支付二维码` / `创建支付表单页面` / `启动订单状态监控`), 而本项目
//   **只有微信扫码"登录"、零支付调用** —— 也就是说收钱这条路是断的。
//
// 本文件实现微信支付 v3 的 Native(扫码)模式。之所以选 Native 而不是 JSAPI:
//   本项目既有 Web 端也有桌面端, Native 出一张 code_url 二维码, 两端都能用,
//   不依赖公众号/小程序的 openid 体系(而登录用的正是那一套, 两者别混)。
//
// 安全要点(每一条都对应一个真实的支付事故):
//   · **回调必须验签** —— 不验签 = 任何人 POST 一个"支付成功"就能白拿余额
//   · **回调必须解密** —— 微信的 resource 是 AES-256-GCM 加密的, 不接就拿到密文
//   · **金额必须二次核对** —— 回调里的金额与订单不一致时绝不能入账(经典的改价攻击)
//   · **回调必须幂等** —— 微信会重推(5s/10s/30s...), 不幂等就加多次钱
//   · **绝不信客户端** —— 前端传来的"我付好了"一律不听, 只认渠道回调与主动查单
//
// 配置(与 wechat-auth-service 同一套约定: env 打底, ai_provider_settings 覆盖):
//   WXPAY_MCH_ID            商户号
//   WXPAY_SERIAL_NO         商户证书序列号
//   WXPAY_PRIVATE_KEY       商户 API 私钥(PEM 内容, 支持 \n 转义的单行形式)
//   WXPAY_APIV3_KEY         APIv3 密钥(32 位)
//   WXPAY_PLATFORM_CERT     微信支付平台证书(PEM, 用于回调验签)
//   WXPAY_NOTIFY_URL        回调地址(必须公网可达)
// 缺任一 → 进入 mock 模式(与 wechat-auth 的 isMockMode 语义一致), 前端标注"模拟支付"。
import { createSign, createDecipheriv, createVerify, randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";

const WXPAY_HOST = "https://api.mch.weixin.qq.com";

export interface WxPayConfig {
  mchId: string;
  serialNo: string;
  privateKey: string;
  apiV3Key: string;
  platformCert: string;
  notifyUrl: string;
  enabled: boolean;
}

let cached: WxPayConfig | null = null;

/** 把 env 里的 `\n` 字面量还原成真换行 —— PEM 单行存放是常见做法 */
function unescapePem(s: string): string {
  return (s ?? "").replace(/\\n/g, "\n").trim();
}

async function loadConfig(): Promise<WxPayConfig> {
  if (cached) return cached;

  const fromEnv: WxPayConfig = {
    mchId: process.env.WXPAY_MCH_ID ?? "",
    serialNo: process.env.WXPAY_SERIAL_NO ?? "",
    privateKey: unescapePem(process.env.WXPAY_PRIVATE_KEY ?? ""),
    apiV3Key: process.env.WXPAY_APIV3_KEY ?? "",
    platformCert: unescapePem(process.env.WXPAY_PLATFORM_CERT ?? ""),
    notifyUrl: process.env.WXPAY_NOTIFY_URL ?? "",
    enabled: false,
  };
  fromEnv.enabled = !!(fromEnv.mchId && fromEnv.serialNo && fromEnv.privateKey && fromEnv.apiV3Key);

  let conf = fromEnv;
  try {
    // 2026-10-02 修正: 原读的是 `ai_provider_settings(key, value)` —— 本表**没有这两列**
    //   (003 迁移建的是 id + 固定业务列)。所以这里永远抛 column does not exist 并被吞掉,
    //   表现为"后台存了支付配置但一直是模拟支付"。改读 metadata jsonb, 同 openaiKeys/appConfig。
    const r = await pool.query(
      `select metadata->'wechatPay' as cfg from ai_provider_settings where id='global'`);
    const cfg = r.rows[0]?.cfg;
    if (cfg) {
      const v = typeof cfg === "string" ? JSON.parse(cfg) : cfg;
      conf = {
        ...fromEnv,
        ...v,
        privateKey: unescapePem(v.privateKey ?? fromEnv.privateKey),
        platformCert: unescapePem(v.platformCert ?? fromEnv.platformCert),
      };
      conf.enabled = !!(conf.mchId && conf.serialNo && conf.privateKey && conf.apiV3Key);
    }
  } catch { /* 表未就绪, 用 env */ }

  cached = conf;
  return conf;
}

/** 后台改了配置要能立刻生效 —— 否则改完必须重启服务才管用 */
export function resetPayConfigCache() { cached = null; }

/** 无配置时走模拟模式(开发/演示)。**生产必须有配置**, 否则前端会显示"模拟支付" */
export async function isPayMockMode(): Promise<boolean> {
  return !(await loadConfig()).enabled;
}

export async function getPayConfigPublic() {
  const c = await loadConfig();
  return {
    mchId: c.mchId ? `${c.mchId.slice(0, 4)}****` : "",
    enabled: c.enabled,
    hasPlatformCert: !!c.platformCert,
    notifyUrl: c.notifyUrl,
    isMock: !c.enabled,
  };
}

// ════════════════════ 签名 ════════════════════

/**
 * 微信支付 v3 的请求签名。
 *
 * 构造串(每行以 \n 结尾, **最后一行也要有**):
 *   HTTP方法\nURL(path+query)\n时间戳\n随机串\n请求体\n
 * 再用商户私钥做 SHA256withRSA, base64。
 */
function buildAuthHeader(cfg: WxPayConfig, method: string, urlPath: string, body: string): string {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID().replace(/-/g, "");
  const message = `${method}\n${urlPath}\n${ts}\n${nonce}\n${body}\n`;
  const signature = createSign("RSA-SHA256").update(message).sign(cfg.privateKey, "base64");
  return `WECHATPAY2-SHA256-RSA2048 mchid="${cfg.mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${ts}",serial_no="${cfg.serialNo}"`;
}

async function wxRequest<T>(
  cfg: WxPayConfig, method: "GET" | "POST", urlPath: string, body?: unknown,
): Promise<{ ok: boolean; status: number; data?: T; error?: string; raw?: string }> {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const headers: Record<string, string> = {
    Authorization: buildAuthHeader(cfg, method, urlPath, payload),
    Accept: "application/json",
    "User-Agent": "SocioSeek/1.0",
  };
  if (payload) headers["Content-Type"] = "application/json";

  let resp: Response;
  try {
    resp = await fetch(`${WXPAY_HOST}${urlPath}`, {
      method, headers, body: payload || undefined,
    });
  } catch (e: unknown) {
    return { ok: false, status: 0, error: `请求微信支付失败: ${e instanceof Error ? e.message : String(e)}` };
  }

  const text = await resp.text();
  if (!resp.ok) {
    return { ok: false, status: resp.status, error: `${resp.status} ${text.slice(0, 300)}`, raw: text };
  }
  try {
    return { ok: true, status: resp.status, data: JSON.parse(text) as T, raw: text };
  } catch {
    return { ok: true, status: resp.status, data: undefined, raw: text };
  }
}

// ════════════════════ 下单(Native 扫码) ════════════════════

export interface NativeOrderResult {
  ok: boolean;
  error?: string;
  /** 二维码内容, 前端把它渲染成二维码 */
  codeUrl?: string;
  prepayId?: string;
  mock?: boolean;
}

/**
 * Native 下单 —— 返回 `code_url`, 前端渲染成二维码给用户扫。
 *
 * amount 单位是**分**(整数)。微信要求 total 为整数分, 且必须与订单表里存的金额一致,
 *  所以我们不从调用方二次取值, 由 payment-order-service 落库后把订单金额传进来。
 */
export async function createNativeOrder(input: {
  outTradeNo: string;
  description: string;
  amountCents: number;
  attach?: string;
}): Promise<NativeOrderResult> {
  const cfg = await loadConfig();

  if (!cfg.enabled) {
    // 模拟模式: 给一个可被前端识别的假 code_url, 让整条链路(下单→轮询→确认)能走通
    return {
      ok: true,
      mock: true,
      codeUrl: `weixin://wxpay/bizpayurl?pr=MOCK${input.outTradeNo.slice(-12)}`,
      prepayId: `mock_prepay_${input.outTradeNo}`,
    };
  }

  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return { ok: false, error: "金额必须是正整数(分)" };
  }
  if (!cfg.notifyUrl) {
    return { ok: false, error: "未配置 WXPAY_NOTIFY_URL —— 微信支付要求回调地址公网可达" };
  }

  const res = await wxRequest<{ code_url?: string; prepay_id?: string }>(
    cfg, "POST", "/v3/pay/transactions/native",
    {
      appid: process.env.WECHAT_APP_ID ?? "",
      mchid: cfg.mchId,
      description: input.description.slice(0, 127),
      out_trade_no: input.outTradeNo,
      notify_url: cfg.notifyUrl,
      amount: { total: input.amountCents, currency: "CNY" },
      attach: input.attach,
    },
  );

  if (!res.ok || !res.data?.code_url) {
    return { ok: false, error: res.error ?? "微信未返回 code_url" };
  }
  return { ok: true, codeUrl: res.data.code_url, prepayId: res.data.prepay_id };
}

// ════════════════════ 主动查单 ════════════════════

/**
 * 主动查单 —— **回调丢了也能补**。
 *
 * 为什么必须有: 回调是"最好情况", 网络抖动/服务重启/防火墙都可能让回调永远不到,
 *  那笔钱收了但用户余额没加, 是会被投诉的。前端轮询订单状态时顺手查一次渠道,
 *  是最省事又最可靠的兜底。
 */
export async function queryOrder(outTradeNo: string): Promise<{
  ok: boolean; error?: string;
  tradeState?: string;  // SUCCESS / NOTPAY / CLOSED / REFUND / PAYERROR
  transactionId?: string;
  amountCents?: number;
  successTime?: string;
}> {
  const cfg = await loadConfig();
  if (!cfg.enabled) {
    return { ok: false, error: "未配置微信支付" };
  }
  const res = await wxRequest<{
    trade_state?: string; transaction_id?: string;
    amount?: { total?: number }; success_time?: string;
  }>(cfg, "GET", `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${cfg.mchId}`);

  if (!res.ok) return { ok: false, error: res.error };
  return {
    ok: true,
    tradeState: res.data?.trade_state,
    transactionId: res.data?.transaction_id,
    amountCents: res.data?.amount?.total,
    successTime: res.data?.success_time,
  };
}

// ════════════════════ 回调验签 + 解密 ════════════════════

/**
 * 校验回调的签名。
 *
 * 验签串(与请求签名同构, 但用**微信平台证书**而非商户私钥):
 *   时间戳\n随机串\n回调体\n
 *
 * ⚠ 不验签的后果不是"少一道保险", 而是**任何人 curl 一下就能给自己加余额**。
 *   mock 模式下没有平台证书, 这种情况**一律拒绝**(返回 false), 不放行。
 */
export async function verifyNotifySignature(headers: {
  timestamp?: string; nonce?: string; signature?: string; serial?: string;
  body: string;
}): Promise<{ ok: boolean; error?: string }> {
  const cfg = await loadConfig();
  if (!cfg.enabled) return { ok: false, error: "未配置微信支付, 拒绝回调" };
  if (!cfg.platformCert) {
    return { ok: false, error: "未配置微信支付平台证书(WXPAY_PLATFORM_CERT), 无法验签 —— 拒绝回调" };
  }
  const { timestamp, nonce, signature, body } = headers;
  if (!timestamp || !nonce || !signature) {
    return { ok: false, error: "回调缺少验签头" };
  }
  // 防重放: 时间戳偏离超过 5 分钟直接拒
  const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(skew) || skew > 300) {
    return { ok: false, error: `回调时间戳偏差过大(${skew}s), 疑似重放` };
  }
  const message = `${timestamp}\n${nonce}\n${body}\n`;
  try {
    const ok = createVerify("RSA-SHA256")
      .update(message)
      .verify(cfg.platformCert, signature, "base64");
    return ok ? { ok: true } : { ok: false, error: "回调验签失败" };
  } catch (e: unknown) {
    return { ok: false, error: `验签异常: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * 解密回调的 resource 字段(AES-256-GCM)。
 *
 * 微信的密钥就是 APIv3 密钥(32 字节)。除了密文, 还用到 nonce 和 associated_data。
 * 不做这一步只能拿到密文, 等于没接回调。
 */
export async function decryptNotifyResource(resource: {
  ciphertext: string; nonce: string; associated_data?: string;
}): Promise<{ ok: boolean; error?: string; data?: Record<string, unknown> }> {
  const cfg = await loadConfig();
  if (!cfg.apiV3Key) return { ok: false, error: "未配置 APIv3 密钥" };
  if (Buffer.byteLength(cfg.apiV3Key) !== 32) {
    return { ok: false, error: `APIv3 密钥长度必须为 32 字节, 当前 ${Buffer.byteLength(cfg.apiV3Key)}` };
  }
  try {
    const buf = Buffer.from(resource.ciphertext, "base64");
    // GCM 的密文尾部 16 字节是 auth tag
    const authTag = buf.subarray(buf.length - 16);
    const data = buf.subarray(0, buf.length - 16);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(cfg.apiV3Key, "utf8"),
      Buffer.from(resource.nonce, "utf8"),
    );
    decipher.setAuthTag(authTag);
    decipher.setAAD(Buffer.from(resource.associated_data ?? "", "utf8"));
    const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    return { ok: true, data: JSON.parse(plain) as Record<string, unknown> };
  } catch (e: unknown) {
    return { ok: false, error: `解密回调失败: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ════════════════════ 退款 ════════════════════

export async function createRefund(input: {
  outTradeNo: string;
  outRefundNo: string;
  refundCents: number;
  totalCents: number;
  reason?: string;
}): Promise<{ ok: boolean; error?: string; refundId?: string; mock?: boolean }> {
  const cfg = await loadConfig();

  if (!cfg.enabled) {
    return { ok: true, mock: true, refundId: `mock_refund_${input.outRefundNo}` };
  }
  if (input.refundCents <= 0 || input.refundCents > input.totalCents) {
    return { ok: false, error: `退款金额(${input.refundCents})非法, 订单总额 ${input.totalCents}` };
  }

  const res = await wxRequest<{ refund_id?: string }>(cfg, "POST", "/v3/refund/domestic/refunds", {
    out_trade_no: input.outTradeNo,
    out_refund_no: input.outRefundNo,
    reason: (input.reason ?? "").slice(0, 80),
    amount: { refund: input.refundCents, total: input.totalCents, currency: "CNY" },
  });

  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, refundId: res.data?.refund_id };
}
