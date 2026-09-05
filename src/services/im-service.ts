// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// im-service.ts — IM 接入（飞书/钉钉/Telegram/企业微信 机器人远程对话）
// 能力: 接收消息 → 命令解析(状态/项目/评测/审批/告警) → 回复; 审批通过 webhook 推送
// 飞书/钉钉/Telegram: 平台 webhook 协议(官方文档格式)
// 企业微信: 自建应用双向 + 群机器人(见 wecom-service.ts, 协议对齐企业微信官方文档)
// 配置: DB(im_config 表) 优先, env 兜底:
//   IM_FEISHU_WEBHOOK / IM_DINGTALK_WEBHOOK / IM_TELEGRAM_TOKEN / IM_TELEGRAM_CHAT_ID
// 免依赖实现: 全用 fetch + node:crypto(企业微信 AES), 不引入 SDK
import { config } from "../config/env.js";
import { pool } from "../db/pool.js";

export interface ImConfig {
  feishuWebhook: string;
  dingtalkWebhook: string;
  telegramToken: string;
  telegramChatId: string;
  wecomCorpId: string;
  wecomCorpSecret: string;
  wecomAgentId: string;
  wecomCallbackToken: string;
  wecomEncodingAesKey: string;
  wecomWebhook: string;
  wecomTouser: string;
}

/** 读 IM 配置: DB 优先(已存值), env 兜底(未配置时) */
export async function getImConfig(): Promise<ImConfig> {
  try {
    const r = await pool.query("select feishu_webhook, dingtalk_webhook, telegram_token, telegram_chat_id, wecom_corp_id, wecom_corp_secret, wecom_agent_id, wecom_callback_token, wecom_encoding_aes_key, wecom_webhook, wecom_touser from im_config where id = 1");
    if (r.rows[0]) {
      return {
        feishuWebhook: r.rows[0].feishu_webhook || config.IM_FEISHU_WEBHOOK || "",
        dingtalkWebhook: r.rows[0].dingtalk_webhook || config.IM_DINGTALK_WEBHOOK || "",
        telegramToken: r.rows[0].telegram_token || config.IM_TELEGRAM_TOKEN || "",
        telegramChatId: r.rows[0].telegram_chat_id || config.IM_TELEGRAM_CHAT_ID || "",
        wecomCorpId: r.rows[0].wecom_corp_id || "",
        wecomCorpSecret: r.rows[0].wecom_corp_secret || "",
        wecomAgentId: r.rows[0].wecom_agent_id || "",
        wecomCallbackToken: r.rows[0].wecom_callback_token || "",
        wecomEncodingAesKey: r.rows[0].wecom_encoding_aes_key || "",
        wecomWebhook: r.rows[0].wecom_webhook || "",
        wecomTouser: r.rows[0].wecom_touser || "",
      };
    }
  } catch { /* 表不存在(迁移未跑) → env */ }
  return {
    feishuWebhook: config.IM_FEISHU_WEBHOOK || "",
    dingtalkWebhook: config.IM_DINGTALK_WEBHOOK || "",
    telegramToken: config.IM_TELEGRAM_TOKEN || "",
    telegramChatId: config.IM_TELEGRAM_CHAT_ID || "",
    wecomCorpId: "", wecomCorpSecret: "", wecomAgentId: "", wecomCallbackToken: "",
    wecomEncodingAesKey: "", wecomWebhook: "", wecomTouser: "",
  };
}

/** 保存 IM 配置(前端面板; 空串清空该渠道) */
export async function saveImConfig(cfg: Partial<ImConfig>): Promise<ImConfig> {
  const cur = await getImConfig();
  const next = {
    feishuWebhook: cfg.feishuWebhook !== undefined ? cfg.feishuWebhook.trim() : cur.feishuWebhook,
    dingtalkWebhook: cfg.dingtalkWebhook !== undefined ? cfg.dingtalkWebhook.trim() : cur.dingtalkWebhook,
    telegramToken: cfg.telegramToken !== undefined ? cfg.telegramToken.trim() : cur.telegramToken,
    telegramChatId: cfg.telegramChatId !== undefined ? cfg.telegramChatId.trim() : cur.telegramChatId,
    wecomCorpId: cfg.wecomCorpId !== undefined ? cfg.wecomCorpId.trim() : cur.wecomCorpId,
    wecomCorpSecret: cfg.wecomCorpSecret !== undefined ? cfg.wecomCorpSecret.trim() : cur.wecomCorpSecret,
    wecomAgentId: cfg.wecomAgentId !== undefined ? cfg.wecomAgentId.trim() : cur.wecomAgentId,
    wecomCallbackToken: cfg.wecomCallbackToken !== undefined ? cfg.wecomCallbackToken.trim() : cur.wecomCallbackToken,
    wecomEncodingAesKey: cfg.wecomEncodingAesKey !== undefined ? cfg.wecomEncodingAesKey.trim() : cur.wecomEncodingAesKey,
    wecomWebhook: cfg.wecomWebhook !== undefined ? cfg.wecomWebhook.trim() : cur.wecomWebhook,
    wecomTouser: cfg.wecomTouser !== undefined ? cfg.wecomTouser.trim() : cur.wecomTouser,
  };
  try {
    await pool.query(
      `update im_config set feishu_webhook = $1, dingtalk_webhook = $2, telegram_token = $3, telegram_chat_id = $4,
       wecom_corp_id = $5, wecom_corp_secret = $6, wecom_agent_id = $7, wecom_callback_token = $8,
       wecom_encoding_aes_key = $9, wecom_webhook = $10, wecom_touser = $11, updated_at = now() where id = 1`,
      [next.feishuWebhook, next.dingtalkWebhook, next.telegramToken, next.telegramChatId,
       next.wecomCorpId, next.wecomCorpSecret, next.wecomAgentId, next.wecomCallbackToken,
       next.wecomEncodingAesKey, next.wecomWebhook, next.wecomTouser]
    );
  } catch (e: any) {
    throw new Error(`IM 配置保存失败(迁移 112 未跑?): ${String(e?.message || e).slice(0, 80)}`);
  }
  return next;
}

export interface ImMessage {
  platform: "feishu" | "dingtalk" | "telegram" | "wecom";
  text: string;
  from?: string;
}

export interface ImReply {
  text: string;
}

// ─── 发送（webhook 机器人推送） ───

/** 飞书自定义机器人推送（text 消息） */
export async function sendFeishu(webhook: string, text: string): Promise<boolean> {
  try {
    const resp = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msg_type: "text", content: { text } }),
    });
    const j = await resp.json().catch(() => null);
    return resp.ok && (j?.code === 0 || j?.StatusCode === 0 || j?.code === undefined);
  } catch { return false; }
}

/** 钉钉机器人推送（text 消息） */
export async function sendDingtalk(webhook: string, text: string): Promise<boolean> {
  try {
    const resp = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "text", text: { content: text } }),
    });
    const j = await resp.json().catch(() => null);
    return resp.ok && j?.errcode === 0;
  } catch { return false; }
}

/** Telegram bot 推送（sendMessage API） */
export async function sendTelegram(token: string, chatId: string, text: string): Promise<boolean> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    const j = await resp.json().catch(() => null);
    return resp.ok && j?.ok === true;
  } catch { return false; }
}

/** 按配置广播到全部已配 IM 平台(DB 配置优先; 含企业微信: 群机器人 webhook + 自建应用) */
export async function imBroadcast(text: string): Promise<{ feishu: boolean; dingtalk: boolean; telegram: boolean; wecom: boolean }> {
  const cfg = await getImConfig();
  const feishu = cfg.feishuWebhook ? await sendFeishu(cfg.feishuWebhook, text) : false;
  const dingtalk = cfg.dingtalkWebhook ? await sendDingtalk(cfg.dingtalkWebhook, text) : false;
  let telegram = false;
  if (cfg.telegramToken && cfg.telegramChatId) {
    telegram = await sendTelegram(cfg.telegramToken, cfg.telegramChatId, text);
  }
  // 企业微信: 群机器人 webhook 优先; 自建应用(无 webhook 时, 发给 touser)
  let wecom = false;
  try {
    if (cfg.wecomWebhook) {
      const { wecomWebhookSend } = await import("./wecom-service.js");
      wecom = await wecomWebhookSend(cfg.wecomWebhook, text);
    } else if (cfg.wecomCorpId && cfg.wecomCorpSecret && cfg.wecomAgentId && (cfg.wecomTouser || "@all")) {
      const { wecomSendText } = await import("./wecom-service.js");
      const r = await wecomSendText({ corpId: cfg.wecomCorpId, corpSecret: cfg.wecomCorpSecret, agentId: cfg.wecomAgentId, content: text, touser: cfg.wecomTouser || "@all" });
      wecom = r.ok;
    }
  } catch { wecom = false; }
  return { feishu, dingtalk, telegram, wecom };
}

// ─── 接收（webhook 回调解析） ───

/** 解析飞书回调 body → 消息文本 */
export function parseFeishuCallback(body: any): ImMessage | null {
  const text = body?.event?.message?.content;
  if (!text) return null;
  try {
    const parsed = JSON.parse(String(text));
    return { platform: "feishu", text: String(parsed.text || ""), from: body?.event?.sender?.sender_id?.open_id };
  } catch {
    return { platform: "feishu", text: String(text).substring(0, 2000), from: body?.event?.sender?.sender_id?.open_id };
  }
}

/** 解析钉钉回调 body → 消息文本 */
export function parseDingtalkCallback(body: any): ImMessage | null {
  const text = body?.text?.content;
  if (!text) return null;
  return { platform: "dingtalk", text: String(text), from: body?.senderStaffId };
}

/** 解析 Telegram 回调 body → 消息文本 */
export function parseTelegramCallback(body: any): ImMessage | null {
  const text = body?.message?.text;
  if (!text) return null;
  return { platform: "telegram", text: String(text), from: String(body?.message?.chat?.id || "") };
}

// ─── 命令解析（远程对话: 查状态/切项目/审批） ───

/**
 * 解析 IM 命令 → 动作
 * 支持: 状态 / 项目列表 / 评测状态 / 审批 / 帮助
 */
export async function handleImCommand(msg: ImMessage): Promise<ImReply> {
  const text = msg.text.trim();
  const lower = text.toLowerCase();

  if (lower.includes("帮助") || lower.includes("help") || lower.includes("?")) {
    return {
      text: [
        "MarxSphere IM 助手可用命令：",
        "· 状态 — 服务/评测/记忆状态",
        "· 项目 — 项目列表",
        "· 评测 — 最近评测结果",
        "· 审批 — 待审批任务",
        "· 告警 — 最近告警",
      ].join("\n"),
    };
  }

  if (lower.includes("状态") || lower.includes("status")) {
    try {
      const { checkJupyterReady } = await import("./jupyter-service.js");
      const jp = checkJupyterReady();
      const rows = await (await import("../db/pool.js")).pool.query("select count(*)::int n from documents where archived_at is null");
      const docs = rows.rows[0]?.n ?? 0;
      return { text: `✅ 服务正常\n· 文献库: ${docs} 篇\n· Notebook Python: ${jp.ready ? "就绪" : "未配置"}\n· 记忆: 见 /api/memory` };
    } catch (e: any) {
      return { text: `❌ 状态查询失败: ${String(e?.message || e).slice(0, 100)}` };
    }
  }

  if (lower.includes("项目") || lower.includes("project")) {
    try {
      const r = await (await import("../db/pool.js")).pool.query(
        "select name, created_at from sources where archived_at is null order by created_at desc limit 10"
      );
      const list = r.rows.map((x: any) => `· ${x.name}`).join("\n");
      return { text: `📁 项目列表（${r.rows.length}）:\n${list || "（无）"}` };
    } catch (e: any) {
      return { text: `❌ 项目查询失败: ${String(e?.message || e).slice(0, 100)}` };
    }
  }

  if (lower.includes("评测") || lower.includes("eval")) {
    try {
      const r = await (await import("../db/pool.js")).pool.query(
        "select eval_run_id, created_at from agent_eval_runs where eval_run_id like 'eval-%' order by created_at desc limit 3"
      );
      const list = r.rows.map((x: any) => `· ${x.eval_run_id} @ ${new Date(x.created_at).toISOString().substring(0, 16)}`).join("\n");
      return { text: `📊 最近评测:\n${list || "（无）"}` };
    } catch (e: any) {
      return { text: `❌ 评测查询失败: ${String(e?.message || e).slice(0, 100)}` };
    }
  }

  if (lower.includes("审批") || lower.includes("approve")) {
    try {
      const r = await (await import("../db/pool.js")).pool.query(
        "select id, title, status from agent_tasks where status in ('pending_approval','awaiting_approval') limit 5"
      );
      const list = r.rows.map((x: any) => `· ${x.title?.substring(0, 40)} [${x.status}]`).join("\n");
      return { text: `⏳ 待审批任务:\n${list || "（无）"}` };
    } catch (e: any) {
      return { text: `❌ 审批查询失败: ${String(e?.message || e).slice(0, 100)}` };
    }
  }

  if (lower.includes("告警") || lower.includes("alert")) {
    try {
      const r = await (await import("../db/pool.js")).pool.query(
        "select level, category, message from alerts order by created_at desc limit 5"
      );
      const list = r.rows.map((x: any) => `· [${x.level}] ${x.message?.substring(0, 50)}`).join("\n");
      return { text: `🔔 最近告警:\n${list || "（无）"}` };
    } catch (e: any) {
      return { text: `❌ 告警查询失败: ${String(e?.message || e).slice(0, 100)}` };
    }
  }

  return { text: `收到: "${text.substring(0, 80)}"\n输入「帮助」查看可用命令` };
}

export const imService = {
  sendFeishu, sendDingtalk, sendTelegram, imBroadcast,
  parseFeishuCallback, parseDingtalkCallback, parseTelegramCallback,
  handleImCommand, getImConfig, saveImConfig,
};
