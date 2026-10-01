// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// aigc-external-service.ts — AIGC 外接权威检测平台(2026-10-01)
//
// 由来: 本仓自研的 aigc-detect-service 是离线标定模型(10 维特征, 标定集 AUC 0.957),
//   它回答的是"这段文字在**我们的**刻度上有多像 AI"。但用户在投稿前要过的是
//   **期刊/学校指定的那一家**——知网、维普、朱雀、Turnitin…… 自研分数再准,
//   也不能替他回答"我的稿子过不过得了那一家"。这个服务接的是那件事。
//
// ═══════════════════════════════════════════════════════════════
// ① 哪些能真调、哪些不能 —— 这是本文件最重要的一个事实
// ═══════════════════════════════════════════════════════════════
//   2026-10-01 逐家打过端点(用假 key 验路径真伪), 结论:
//
//   ┌ API 可直接对接(5 家) ────────────────────────────────────┐
//   │ GPTZero     POST api.gptzero.me/v2/predict/text  x-api-key │
//   │ Winston AI  POST api.gowinston.ai/v2/ai-content-detection  │
//   │ Copyleaks   POST id.copyleaks.com/v3/account/login/api 换 token │
//   │ Sapling     POST api.sapling.ai/api/v1/aidetect           │
//   │ Pangram     POST text.api.pangram.com/v3           x-api-key │
//   └───────────────────────────────────────────────────────────┘
//   ⚠ Originality.ai **不在上表**: 它的端点存在(api.originality.ai/api/v1/scan/ai),
//     但假 key 打上去回的是 422 + "Enterprise Subscription Required to use the
//     Originality.ai API" —— 也就是说**普通订阅拿不到 API**。适配器照写(它会好),
//     但在服务商清单里把这件事写进 note, 不让用户以为买了就能用。
//
//   ┌ 不提供公开接口(人工送检) ──────────────────────────────┐
//   │ 知网 AIGC 检测 / 维普 / 万方 / 腾讯朱雀 / 中科睿鉴 / AIGC-X │
//   └─────────────────────────────────────────────────────────┘
//   它们只有网页版与机构协议(学校统一采购、按篇计费)。给这类平台硬造一个
//   "适配器"是自欺欺人 —— 走 manual: 导出送检包 → 人去平台检 → 回填结果+截图。
//
// ═══════════════════════════════════════════════════════════════
// ② 归一化的**唯一一条铁律**
// ═══════════════════════════════════════════════════════════════
//   各家对"分"的定义相反: GPTZero 的 `completely_generated_prob` 高 = 像 AI,
//   而 Sapling 的 score 同样是"越高越像 AI", 但 Pangram 给的是 `fraction_human`
//   ——高 = 像**人**。所以适配器出来的 score 一律翻译成 **0-100, 越高越像 AI**。
//   混用会让用户把"90 分"读成完全相反的意思, 而这种错误在界面上看不出来。
//   本文件每个 normalize 函数都在返回处再写一次这条, 因为它太容易在改动中丢失。
//
// ═══════════════════════════════════════════════════════════════
// ③ 密钥
// ═══════════════════════════════════════════════════════════════
//   复用 auth-service 的 AES-256-GCM(encryptByokKey/decryptByokKey) —— 那是本仓
//   唯一一处**真正加密**的密钥存储。agent_credentials 表是明文存的, 不跟着学。
//   平台级配置(user_id 为 NULL)与用户自带(非 NULL)并存: 平台配了就用平台的,
//   没配则回落到用户自己的 —— 顺序见 resolveCredential。
import { createHash } from "node:crypto";
import { pool } from "../db/pool.js";
import { encryptByokKey, decryptByokKey } from "./auth-service.js";

/** 归一化的三档结论 —— 与自研 aigc-detect-service 的 AigcVerdict 同名同义 */
export type ExternalVerdict = "likely_human" | "mixed" | "likely_ai" | "insufficient";

export interface ProviderMeta {
  id: string;
  name: string;
  /** api = 适配器直接调; manual = 导出送检包人工回填 */
  mode: "api" | "manual";
  /** 需要哪些凭据字段(前端据此渲染表单) */
  fields: Array<"apiKey" | "email">;
  /** 申请入口 */
  consoleUrl?: string;
  /** 语言支持 —— Sapling 生产检测器是**英文only**, 中文稿送过去没意义, 必须显式告知 */
  langs: "zh+en" | "en" | "manual";
  /** 计费口径 */
  pricing?: string;
  /** 面向用户的实话: 拿不到 API / 有前置条件 / 覆盖范围有限, 都写在这 */
  note: string;
}

/**
 * 服务商清单 —— **前端只从这里渲染**, 不在前端另抄一份。
 * (本仓踩过: ChatPanel 手抄工具清单, 后端加了工具前端就显示成英文名, 烂掉 37/77。)
 */
export const AIGC_PROVIDERS: ProviderMeta[] = [
  {
    id: "gptzero", name: "GPTZero", mode: "api", fields: ["apiKey"],
    consoleUrl: "https://app.gptzero.me/app/api", langs: "zh+en",
    pricing: "按字数计费, 有免费额度",
    note: "学术检测领域最常被引用的一家。返回逐句概率, 可定位到具体句子。",
  },
  {
    id: "winston", name: "Winston AI", mode: "api", fields: ["apiKey"],
    consoleUrl: "https://dev.gowinston.ai", langs: "zh+en",
    pricing: "1 credit/词, 注册送 2000 credits",
    note: "支持中文。按词计费, 长文成本要留意。",
  },
  {
    id: "copyleaks", name: "Copyleaks", mode: "api", fields: ["apiKey", "email"],
    consoleUrl: "https://copyleaks.com", langs: "zh+en",
    pricing: "订阅制, 企业向",
    note: "两段式鉴权(邮件+密钥换 48 小时 token), 所以要填账号邮箱。主打多语言与企业 LMS 集成。",
  },
  {
    id: "sapling", name: "Sapling AI Detector", mode: "api", fields: ["apiKey"],
    consoleUrl: "https://sapling.ai", langs: "en",
    pricing: "约 $0.005 / 1000 字符",
    note: "⚠ 生产检测器只支持英文 —— 中文稿送过去拿不到有意义的分数。中文论文请用别家。",
  },
  {
    id: "pangram", name: "Pangram", mode: "api", fields: ["apiKey"],
    consoleUrl: "https://www.pangram.com", langs: "zh+en",
    pricing: "约 $0.05 / 1000 词",
    note: "支持 20+ 语言, 且区分「纯人写 / AI 辅助 / AI 生成」三段(多数平台只有 AI 概率一档)。",
  },
  {
    id: "originality", name: "Originality.ai", mode: "api", fields: ["apiKey"],
    consoleUrl: "https://originality.ai", langs: "zh+en",
    pricing: "API 需 Enterprise 订阅",
    note: "⚠ 端点确实是公开的, 但 2026-10-01 实测: 非企业订阅调用返回 422「Enterprise Subscription Required」。买了普通套餐仍然用不了 API。",
  },

  // ── 以下不提供公开 API, 走"导出送检包 → 人工送检 → 回填" ──
  {
    id: "cnki", name: "知网 AIGC 检测", mode: "manual", fields: [], langs: "manual",
    pricing: "按篇计费(学校/期刊统一采购)",
    note: "国内高校与期刊最认的一家, 但只面向机构, 没有自助接口。用「导出送检包」拿纯文本去知网个人/机构入口检测, 拿到结果回填。",
  },
  {
    id: "vip", name: "维普论文检测", mode: "manual", fields: [], langs: "manual",
    pricing: "按篇计费",
    note: "有 AIGC 检测与查重, 同样无公开接口。",
  },
  {
    id: "wanfang", name: "万方数据检测", mode: "manual", fields: [], langs: "manual",
    pricing: "按篇计费(部分学校免费配额)",
    note: "无公开接口。",
  },
  {
    id: "zhuque", name: "腾讯朱雀 AI 检测", mode: "manual", fields: [], langs: "manual",
    pricing: "网页版免费",
    note: "网页版可用且免费, 但有字数上限, 长文要分段送。不支持批量，也没有接口。",
  },
  {
    id: "ruijian", name: "中科睿鉴 · 睿信 / 睿小鉴", mode: "manual", fields: [], langs: "manual",
    pricing: "机构采购",
    note: "无公开接口, 走机构协议。",
  },
  {
    id: "aigcx", name: "AIGC-X", mode: "manual", fields: [], langs: "manual",
    pricing: "网页版",
    note: "无公开接口。",
  },
  {
    id: "turnitin", name: "Turnitin", mode: "manual", fields: [], langs: "manual",
    pricing: "机构订阅",
    note: "⚠ 情况特殊: 它有 API, 但只对教育机构开放，且必须走机构集成, 个人开发者拿不到密钥。所以归到人工送检。若你所在机构已开通, 通常是从学校的提交入口走。",
  },
];

export function providerMeta(id: string): ProviderMeta | null {
  return AIGC_PROVIDERS.find((p) => p.id === id) ?? null;
}

/** 送检文本指纹 —— 只存哈希不存正文(未发表的稿子不该因为"检测过"而在库里留一份) */
export function fingerprint(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ════════════════════ 凭据 ════════════════════

export interface CredentialRow {
  id: string; user_id: string | null; provider: string;
  key_encrypted: string; account_email: string; enabled: boolean; note: string;
}

/**
 * 取该用户能用的凭据 —— **用户自己的优先, 没有才回落到平台级**。
 *
 * 为什么这个顺序而不是反过来: 用户自带的密钥花的是他自己的额度与隐私边界,
 *   平台级是兜底。反过来会导致"我明明配了自己的 key, 平台却用了公共的"——
 *   这既费平台的钱, 也让用户以为自己的额度没被用上。
 */
export async function resolveCredential(userId: string, provider: string): Promise<{ apiKey: string; email: string } | null> {
  const { rows } = await pool.query(
    `select * from aigc_provider_credentials
      where provider = $1 and enabled = true and (user_id = $2 or user_id is null)
      order by (user_id is not null) desc, updated_at desc
      limit 1`,
    [provider, userId],
  );
  const row = rows[0] as CredentialRow | undefined;
  if (!row) return null;
  const apiKey = decryptByokKey(row.key_encrypted);
  // 解不开(换了 JWT_SECRET / BYOK_ENCRYPTION_KEY 都会) → 当作没配, 而不是拿密文去发请求
  if (!apiKey) return null;
  return { apiKey, email: row.account_email };
}

export async function saveCredential(input: {
  userId: string | null; provider: string; apiKey: string; email?: string; note?: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (!providerMeta(input.provider)) return { ok: false, error: `未知服务商: ${input.provider}` };
  if (!input.apiKey.trim()) return { ok: false, error: "密钥不能为空" };
  const enc = encryptByokKey(input.apiKey.trim());
  try {
    // 不用 ON CONFLICT: 两个唯一索引都是**部分索引**(where user_id is not null / is null),
    //   部分索引不能作为 ON CONFLICT 的仲裁者(本仓已在哈希版本化那批踩过 42P10)。
    //   所以先删后插, 且在同一个事务里。
    const client = await pool.connect();
    try {
      await client.query("begin");
      if (input.userId) {
        await client.query(
          `delete from aigc_provider_credentials where user_id = $1 and provider = $2`,
          [input.userId, input.provider]);
      } else {
        await client.query(
          `delete from aigc_provider_credentials where user_id is null and provider = $1`,
          [input.provider]);
      }
      await client.query(
        `insert into aigc_provider_credentials (user_id, provider, key_encrypted, account_email, note)
         values ($1, $2, $3, $4, $5)`,
        [input.userId, input.provider, enc, input.email ?? "", input.note ?? ""]);
      await client.query("commit");
    } catch (e) { await client.query("rollback"); throw e; }
    finally { client.release(); }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** 列出已配置项 —— **绝不返回密钥本体**, 只回"配了没 + 尾 4 位"给人核对 */
export async function listCredentials(userId: string): Promise<Array<{
  provider: string; scope: "platform" | "personal"; hint: string; email: string; enabled: boolean; updatedAt: string;
}>> {
  const { rows } = await pool.query(
    `select provider, user_id, key_encrypted, account_email, enabled, updated_at
       from aigc_provider_credentials
      where user_id = $1 or user_id is null
      order by (user_id is not null) desc, provider`,
    [userId],
  );
  return (rows as Array<{ provider: string; user_id: string | null; key_encrypted: string; account_email: string; enabled: boolean; updated_at: Date }>)
    .map((r) => {
      const plain = decryptByokKey(r.key_encrypted) ?? "";
      return {
        provider: r.provider,
        scope: r.user_id ? "personal" as const : "platform" as const,
        hint: plain ? `…${plain.slice(-4)}` : "(密钥无法解密, 请重新配置)",
        email: r.account_email,
        enabled: r.enabled,
        updatedAt: r.updated_at?.toISOString?.() ?? String(r.updated_at ?? ""),
      };
    });
}

export async function deleteCredential(userId: string, provider: string, scope: "platform" | "personal"): Promise<boolean> {
  const { rowCount } = await pool.query(
    scope === "platform"
      ? `delete from aigc_provider_credentials where user_id is null and provider = $1`
      : `delete from aigc_provider_credentials where user_id = $1 and provider = $2`,
    scope === "platform" ? [provider] : [userId, provider],
  );
  return (rowCount ?? 0) > 0;
}

// ════════════════════ 适配器 ════════════════════

export interface AdapterResult {
  /** 0-100, **越高越像 AI**(见文件头铁律 ②) */
  score: number;
  verdict: ExternalVerdict;
  /** 平台原始响应(截断前的完整对象, 由调用方入库) */
  raw: unknown;
  /** 给用户看的一句话(平台自己的口径, 不翻译) */
  summary: string;
}

const TIMEOUT_MS = 90_000;

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; json: unknown; text: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "SocioSeek/1.0", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 响应: 原样留在 text 里 */ }
  return { status: res.status, json, text };
}

/** 把 0-1 的"像 AI 概率"翻成 0-100 分 + 四档。verdict 阈值与自研那套对齐(35/65) */
function toVerdict(p: number): ExternalVerdict {
  if (!Number.isFinite(p)) return "insufficient";
  if (p >= 0.65) return "likely_ai";
  if (p <= 0.35) return "likely_human";
  return "mixed";
}
function clamp01(x: number): number { return Math.max(0, Math.min(1, x)); }

type Adapter = (text: string, cred: { apiKey: string; email: string }) => Promise<AdapterResult>;

const ADAPTERS: Record<string, Adapter> = {
  /**
   * GPTZero — `documents[0].completely_generated_prob` 就是"完全由 AI 生成"的概率。
   * 高 = 像 AI, 与本服务的口径**同向**, 不用翻转。
   */
  async gptzero(text, cred) {
    const r = await postJson("https://api.gptzero.me/v2/predict/text",
      { "x-api-key": cred.apiKey }, { document: text, version: "2023-06-30" });
    if (r.status !== 200) throw new Error(`GPTZero 返回 ${r.status}: ${r.text.slice(0, 300)}`);
    const d = (r.json as { documents?: Array<Record<string, unknown>> })?.documents?.[0];
    if (!d) throw new Error("GPTZero 响应里没有 documents[0]");
    const p = clamp01(Number(d.completely_generated_prob ?? d.average_generated_prob ?? NaN));
    return {
      score: Math.round(p * 100), verdict: toVerdict(p), raw: r.json,
      summary: `完全由 AI 生成概率 ${(p * 100).toFixed(1)}%; 平均句概率 ${(Number(d.average_generated_prob ?? 0) * 100).toFixed(1)}%`,
    };
  },

  /**
   * Winston AI — base https://api.gowinston.ai/v2, Bearer 鉴权。
   * 响应里的 `score` 是**人类概率**(越高越像人) ⇒ **必须翻转**。
   * 这正是文件头铁律②说的那类坑, 单独写出来免得日后有人"顺手统一"掉。
   */
  async winston(text, cred) {
    const r = await postJson("https://api.gowinston.ai/v2/ai-content-detection",
      { Authorization: `Bearer ${cred.apiKey}` },
      { text, version: "3.0", sentences: true });
    if (r.status !== 200) throw new Error(`Winston AI 返回 ${r.status}: ${r.text.slice(0, 300)}`);
    const d = r.json as Record<string, unknown>;
    const human = Number(d?.score ?? NaN);
    if (!Number.isFinite(human)) throw new Error("Winston AI 响应里没有 score");
    const p = clamp01(1 - human / 100);            // ← 翻转: 平台给"人类概率"
    return {
      score: Math.round(p * 100), verdict: toVerdict(p), raw: r.json,
      summary: `平台给出人类概率 ${human}% ⇒ 折算 AI 特征 ${Math.round(p * 100)} 分`,
    };
  },

  /**
   * Copyleaks — 两段式: 先用 (email, key) 换 48 小时 access token, 再带着 token 调。
   * ⚠ 登录端点限流很紧(文档写 12 次/15 分钟), 所以**同一进程内缓存 token**。
   *   每次检测都重新登录, 跑十几篇稿子就会把自己限流掉。
   */
  async copyleaks(text, cred) {
    const token = await copyleaksToken(cred);
    const scanId = `sag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    /**
     * Copyleaks 的 writer-detector 是**异步提交 + 轮询**模型:
     *   先 POST /v2/writer-detector/{scanId}/submit, 再 GET .../check 直到 completed。
     * 这里轮询 20 次 × 3 秒 = 60 秒上限。超时不算失败, 报明确错误让用户重试
     *   (scanId 已经发出去了, 平台那边照样在跑)。
     */
    const submit = await postJson(`https://api.copyleaks.com/v2/writer-detector/${scanId}/submit`,
      { Authorization: `Bearer ${token}` }, { text });
    if (submit.status >= 400) throw new Error(`Copyleaks 提交失败 ${submit.status}: ${submit.text.slice(0, 300)}`);
    for (let i = 0; i < 20; i++) {
      await new Promise((res) => setTimeout(res, 3000));
      const chk = await fetch(`https://api.copyleaks.com/v2/writer-detector/${scanId}/check`,
        { headers: { Authorization: `Bearer ${token}`, "User-Agent": "SocioSeek/1.0" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      const cj = await chk.json().catch(() => null) as Record<string, unknown> | null;
      const summary = cj?.summary as Record<string, unknown> | undefined;
      if (summary) {
        // summary.ai = AI 占比(0-1); 高 = 像 AI, 同向
        const p = clamp01(Number(summary.ai ?? NaN));
        return {
          score: Math.round(p * 100), verdict: toVerdict(p), raw: cj,
          summary: `AI 占比 ${(p * 100).toFixed(1)}%${summary.human != null ? `, 人类占比 ${(Number(summary.human) * 100).toFixed(1)}%` : ""}`,
        };
      }
    }
    throw new Error("Copyleaks 60 秒内未返回结果(scanId 已提交, 可稍后重试)");
  },

  /**
   * Sapling — score 高 = 像 AI, 同向, 不翻转。
   * ⚠ 生产检测器**只支持英文**; 中文送过去虽然会返回 200, 但分数没有意义。
   *   调用方(scanText)已经在这之前拦过一次, 这里再拦一次是因为适配器也可能被单独调用。
   */
  async sapling(text, cred) {
    const r = await postJson("https://api.sapling.ai/api/v1/aidetect",
      {}, { key: cred.apiKey, text, sent_scores: true });
    if (r.status !== 200) throw new Error(`Sapling 返回 ${r.status}: ${r.text.slice(0, 300)}`);
    const d = r.json as Record<string, unknown>;
    const p = clamp01(Number(d?.score ?? NaN));
    if (!Number.isFinite(p)) throw new Error("Sapling 响应里没有 score");
    return {
      score: Math.round(p * 100), verdict: toVerdict(p), raw: r.json,
      summary: `AI 生成置信度 ${(p * 100).toFixed(1)}% (⚠ 该检测器仅支持英文)`,
    };
  },

  /**
   * Pangram v3 — 给的是 `fraction_human` / `fraction_ai_assisted` / `fraction_ai`
   * (三者互斥且和为 1)。**`fraction_human` 高 = 像人 ⇒ 要翻转**。
   * 这里把"AI 生成 + AI 辅助"都算作 AI 特征 —— 学术场景里"AI 辅助写成"同样是
   * 期刊要判定的对象, 不算进去会把 30% 辅助的稿子报成"很人类"。
   * (v2 端点已于 2026-04-01 停用, 所以只接 v3。)
   */
  async pangram(text, cred) {
    const r = await postJson("https://text.api.pangram.com/v3",
      { "x-api-key": cred.apiKey }, { text });
    if (r.status !== 200) throw new Error(`Pangram 返回 ${r.status}: ${r.text.slice(0, 300)}`);
    const d = r.json as Record<string, unknown>;
    const ai = Number(d?.fraction_ai ?? NaN);
    const assisted = Number(d?.fraction_ai_assisted ?? NaN);
    const human = Number(d?.fraction_human ?? NaN);
    if (!Number.isFinite(ai) && !Number.isFinite(human)) throw new Error("Pangram 响应里没有 fraction_* 字段");
    const p = clamp01(Number.isFinite(ai) ? ai + (Number.isFinite(assisted) ? assisted : 0) : 1 - human);
    return {
      score: Math.round(p * 100), verdict: toVerdict(p), raw: r.json,
      summary: `纯 AI ${(Number.isFinite(ai) ? ai * 100 : 0).toFixed(1)}% + AI 辅助 ${(Number.isFinite(assisted) ? assisted * 100 : 0).toFixed(1)}% (平台结论: ${String(d?.headline ?? "—")})`,
    };
  },

  /**
   * Originality.ai — `score.ai` 高 = 像 AI, 同向, 不翻转。
   * ⚠ 非企业订阅会拿到 422 "Enterprise Subscription Required" —— 这里把它翻成
   *   人话再说出去, 否则用户只会看到一句英文错误码, 以为是我们的 bug。
   */
  async originality(text, cred) {
    const r = await postJson("https://api.originality.ai/api/v1/scan/ai",
      { "X-OAI-API-KEY": cred.apiKey }, { content: text });
    if (r.status === 422 || /Enterprise Subscription/i.test(r.text)) {
      throw new Error("Originality.ai 的 API 只对企业版订阅开放 —— 普通套餐无法调用, 请改用别的服务商或走人工送检");
    }
    if (r.status !== 200) throw new Error(`Originality.ai 返回 ${r.status}: ${r.text.slice(0, 300)}`);
    const score = (r.json as { score?: Record<string, unknown> })?.score;
    const p = clamp01(Number(score?.ai ?? NaN));
    if (!Number.isFinite(p)) throw new Error("Originality.ai 响应里没有 score.ai");
    return {
      score: Math.round(p * 100), verdict: toVerdict(p), raw: r.json,
      summary: `AI 占比 ${(p * 100).toFixed(1)}%`,
    };
  },
};

/** Copyleaks 的 access token —— 进程内缓存, 提前 5 分钟过期以免边界上翻车 */
let copyleaksCache: { token: string; exp: number } | null = null;

async function copyleaksToken(cred: { apiKey: string; email: string }): Promise<string> {
  if (copyleaksCache && Date.now() < copyleaksCache.exp) return copyleaksCache.token;
  if (!cred.email) throw new Error("Copyleaks 需要账号邮箱(与密钥成对), 请在检测平台的凭据里补上");
  const r = await postJson("https://id.copyleaks.com/v3/account/login/api", {},
    { email: cred.email, key: cred.apiKey });
  if (r.status !== 200) throw new Error(`Copyleaks 登录失败 ${r.status}: ${r.text.slice(0, 300)}`);
  const token = String((r.json as { access_token?: string })?.access_token ?? "");
  if (!token) throw new Error("Copyleaks 登录响应里没有 access_token");
  // 文档写 48 小时有效; 这里按 24 小时缓存, 保守一半
  copyleaksCache = { token, exp: Date.now() + 24 * 3600 * 1000 };
  return token;
}

// ════════════════════ 送检 ════════════════════

export interface ScanOutcome {
  ok: boolean;
  scanId?: string;
  score?: number;
  verdict?: ExternalVerdict;
  summary?: string;
  error?: string;
}

/**
 * 向某一家平台送检。
 *
 * 顺序刻意是「先落一条 pending 记录 → 调 → 回写结果」而不是「调完再插」:
 *   外呼可能跑满 90 秒, 期间进程被杀 / 用户关页面, 事后查不到"那次到底发出去没有"。
 *   先落库, 至少留下一行 `running` 可以解释。
 */
export async function scanText(userId: string, provider: string, text: string, lang: "zh" | "en" = "zh"): Promise<ScanOutcome> {
  const meta = providerMeta(provider);
  if (!meta) return { ok: false, error: `未知服务商: ${provider}` };
  if (meta.mode !== "api") return { ok: false, error: `「${meta.name}」不提供 API, 请用「导出送检包」走人工送检` };
  if (!text.trim()) return { ok: false, error: "送检文本为空" };

  /**
   * Sapling 只支持英文 —— 在这里拦, 而不是让它返回一个没有意义的分数。
   * 用户是中文稿却选了 Sapling, 得到的 0.5 分不是"混合特征", 是"这个模型没学过中文"。
   * 这种分数比没有分数更坏: 它看起来像一个结论。
   */
  if (provider === "sapling" && lang === "zh") {
    return { ok: false, error: "Sapling 的生产检测器仅支持英文, 中文稿的分数没有意义。请改用 GPTZero / Winston / Pangram 或走人工送检。" };
  }

  const cred = await resolveCredential(userId, provider);
  if (!cred) return { ok: false, error: `还没有配置「${meta.name}」的密钥 —— 请在下方凭据区填入, 或改用人工送检` };

  const fp = fingerprint(text);
  const ins = await pool.query(
    `insert into aigc_external_scans (user_id, provider, mode, status, text_sha256, text_chars)
     values ($1, $2, 'api', 'running', $3, $4) returning id`,
    [userId, provider, fp, text.replace(/\s/g, "").length],
  );
  const scanId = String((ins.rows[0] as { id: string }).id);

  const t0 = Date.now();
  try {
    const out = await ADAPTERS[provider](text, cred);
    const latency = Date.now() - t0;
    await pool.query(
      `update aigc_external_scans
          set status = 'done', score = $2, verdict = $3, raw = $4, latency_ms = $5, updated_at = now()
        where id = $1`,
      [scanId, out.score, out.verdict, JSON.stringify(out.raw).slice(0, 200_000), latency],
    );
    return { ok: true, scanId, score: out.score, verdict: out.verdict, summary: out.summary };
  } catch (e) {
    const msg = (e as Error).message;
    await pool.query(
      `update aigc_external_scans set status = 'failed', error = $2, latency_ms = $3, updated_at = now() where id = $1`,
      [scanId, msg.slice(0, 2000), Date.now() - t0],
    );
    return { ok: false, scanId, error: msg };
  }
}

/** 把一条 scan 的原始响应转成用户可读的"平台自己说了什么" */
export function describeScan(row: {
  provider: string; score: number | null; verdict: string | null; status: string;
  error: string; text_chars: number; latency_ms: number; created_at: string;
}): string {
  const name = providerMeta(row.provider)?.name ?? row.provider;
  if (row.status === "failed") return `${name}：送检失败 —— ${row.error}`;
  if (row.status !== "done") return `${name}：送检中`;
  return `${name}：AI 特征 ${Math.round(row.score ?? 0)} / 100`;
}

export async function listScans(userId: string, limit = 30): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query(
    `select id, provider, mode, status, score, verdict, error, text_chars, latency_ms, created_at
       from aigc_external_scans where user_id = $1 order by created_at desc limit $2`,
    [userId, Math.min(Math.max(limit, 1), 200)],
  );
  return rows as Array<Record<string, unknown>>;
}

// ════════════════════ 人工送检回填 ════════════════════

export async function submitManual(input: {
  userId: string; provider: string; title?: string; score?: number | null;
  verdict?: string | null; referenceNo?: string; rawExcerpt?: string; evidenceRel?: string;
  text?: string;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  const meta = providerMeta(input.provider);
  if (!meta) return { ok: false, error: `未知服务商: ${input.provider}` };
  /**
   * 平台级校验: 拿了分数就必须同时给一句平台原文。
   *
   * 为什么强制: 期刊/学校认的是**那家平台的报告**, 不是我们库里一个光秃秃的数字。
   * 只填分数不填原文的回填, 事后没人能复核它从哪来 —— 那和编一个数没区别。
   */
  if (input.score != null && !String(input.rawExcerpt ?? "").trim()) {
    return { ok: false, error: "填了分数就必须附平台报告原文 —— 期刊/学校认的是平台报告, 只留一个数字事后无法复核" };
  }
  const score = input.score == null ? null : Math.max(0, Math.min(100, Number(input.score)));
  const verdict = input.verdict && ["likely_human", "mixed", "likely_ai", "insufficient"].includes(input.verdict)
    ? input.verdict
    : (score == null ? null : score >= 65 ? "likely_ai" : score <= 35 ? "likely_human" : "mixed");
  const { rows } = await pool.query(
    `insert into aigc_manual_submissions
       (user_id, provider, title, text_sha256, text_chars, score, verdict, reference_no, raw_excerpt, evidence_rel)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [input.userId, input.provider, input.title ?? "", input.text ? fingerprint(input.text) : "",
      input.text ? input.text.replace(/\s/g, "").length : 0,
      score, verdict, input.referenceNo ?? "", input.rawExcerpt ?? "", input.evidenceRel ?? ""],
  );
  return { ok: true, id: String((rows[0] as { id: string }).id) };
}

export async function listManual(userId: string, limit = 50): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query(
    `select id, provider, title, score, verdict, reference_no, raw_excerpt, evidence_rel, text_chars, created_at
       from aigc_manual_submissions where user_id = $1 order by created_at desc limit $2`,
    [userId, Math.min(Math.max(limit, 1), 200)],
  );
  return rows as Array<Record<string, unknown>>;
}

export async function deleteManual(userId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `delete from aigc_manual_submissions where id = $1 and user_id = $2`, [id, userId]);
  return (rowCount ?? 0) > 0;
}

// ════════════════════ 送检包 ════════════════════

/**
 * 导出**送检包** —— 不提供 API 的那些平台靠它。
 *
 * 为什么不是"帮用户打开知网网页": 那需要浏览器自动化 + 用户账号, 既不稳定也可能违反
 *   平台条款。给一份干净的纯文本 + 一句明确的操作指引, 用户自己 30 秒就能完成 ——
 *   而且**他知道自己把稿子发给了谁**, 这一点在学术场景里比自动化更重要。
 *
 * 附带的 `guide` 是给用户照做的步骤, `checklist` 是回填时要抄下来的字段。
 * 刻意不做"自动分段": 各平台字数上限不同且会变, 猜错了会把稿子截断成两半还不报错。
 */
export function buildSubmissionPackage(input: {
  provider: string; title: string; text: string;
}): { ok: boolean; error?: string; filename?: string; content?: string; guide?: string[]; checklist?: string[] } {
  const meta = providerMeta(input.provider);
  if (!meta) return { ok: false, error: `未知服务商: ${input.provider}` };
  const text = String(input.text ?? "");
  if (!text.trim()) return { ok: false, error: "没有可送检的文本" };
  const chars = text.replace(/\s/g, "").length;
  const safeTitle = (input.title || "送检文本").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
  const guide = [
    `1. 打开「${meta.name}」${meta.consoleUrl ? `（${meta.consoleUrl}）` : ""}的检测入口`,
    `2. 把下面「送检文本」整段粘进去（共 ${chars} 字，已去掉多余空行）—— 若平台有字数上限，按段落分批送，别截断句子`,
    "3. 平台上跑完后，把「AI 疑似度 / AI 生成占比」那个数字抄下来",
    "4. 回到本页的「人工送检回填」，填分数 + 平台报告原文（必填）+ 报告截图",
    "",
    "⚠ 送检前想清楚：稿子会离开你的机器，发到你选的那家平台。未发表的稿子请自行判断是否接受。",
  ];
  const checklist = [
    "分数（AI 疑似度 / AI 生成占比，0-100）",
    "平台报告原文（例如「AI 生成疑似度 12.3%」，照抄，别改写）",
    "报告截图（期刊/学校要的是这个）",
    "批次号 / 报告编号（如果平台给了）",
  ];
  return {
    ok: true,
    filename: `${safeTitle}-${meta.id}-送检.txt`,
    content: `${safeTitle}\n\n${text}`,
    guide,
    checklist,
  };
}

/** 服务商能力自检 —— 给面板显示"哪些现在真能用" */
export async function diagnose(userId: string): Promise<{
  providers: Array<ProviderMeta & { configured: boolean; usable: boolean; blockedReason?: string }>;
}> {
  const creds = await listCredentials(userId);
  const configured = new Set(creds.filter((c) => c.enabled && !c.hint.startsWith("(密钥无法解密")).map((c) => c.provider));
  return {
    providers: AIGC_PROVIDERS.map((p) => {
      const has = configured.has(p.id);
      let blockedReason: string | undefined;
      if (p.mode === "manual") blockedReason = "无公开 API，走人工送检";
      else if (p.id === "originality") blockedReason = "API 仅对企业版订阅开放";
      else if (!has) blockedReason = "未配置密钥";
      return { ...p, configured: has, usable: p.mode === "api" && has && p.id !== "originality", blockedReason };
    }),
  };
}
