// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// log-sanitizer.ts — 日志脱敏（BOOK-GAP-ROADMAP P0-15）
// 书中 Ch3: 本地模型做 PII 检测脱敏; 正则快速过滤覆盖 90% + LLM 深度分析可选(LOG_SANITIZE_LLM=true默认关)
// 第一层正则（零成本）: 身份证/手机号/银行卡/IPv4/sk-key/Authorization → [REDACTED:type]
// 注意: 不改动入库数据本身，只改日志/请求记录的可读层

/** 正则第一层（覆盖 90% 结构化 PII） */
const RULES: Array<{ re: RegExp; type: string }> = [
  { re: /\b\d{17}[\dXx]\b/g, type: "ID" },                    // 身份证
  { re: /\b1[3-9]\d{9}\b/g, type: "PHONE" },                  // 手机号
  { re: /\b\d{16,19}\b/g, type: "BANKCARD" },                 // 银行卡
  { re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, type: "IP" },         // IPv4
  { re: /\bsk-[a-zA-Z0-9]{16,}\b/g, type: "API_KEY" },        // sk- 开头 key
  { re: /(authorization\s*:\s*bearer\s+)[a-zA-Z0-9._-]+/gi, type: "AUTH" }, // Authorization: Bearer
];

/** 脱敏单行文本（正则层） */
export function sanitizeLine(text: string): string {
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.re, (match) => {
      // 已是脱敏标记的跳过
      if (match.startsWith("[REDACTED")) return match;
      return `[REDACTED:${rule.type}]`;
    });
  }
  return out;
}

/** 脱敏结构化对象（递归处理字符串字段） */
export function sanitizeObject(obj: unknown, depth = 0): unknown {
  if (depth > 6) return obj;  // 防深递归
  if (typeof obj === "string") return sanitizeLine(obj);
  if (Array.isArray(obj)) return obj.map((v) => sanitizeObject(v, depth + 1));
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = sanitizeObject(v, depth + 1);
    }
    return out;
  }
  return obj;
}

/** 是否启用 LLM 深度脱敏（默认关；命中疑似敏感关键词段落时调用） */
export function isLlmSanitizeEnabled(): boolean {
  return process.env.LOG_SANITIZE_LLM === "true";
}

/** 疑似敏感内容检测（含密码/账号/地址/证件等关键词的段落） */
export function hasSuspiciousContent(text: string): boolean {
  return /(?:密码|账号|地址|证件|身份证|手机号|银行卡|住址|电话|邮箱)/.test(text);
}
