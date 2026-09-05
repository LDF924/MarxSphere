// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// ImPanel.tsx — IM 接入面板(飞书/钉钉/Telegram 机器人远程对话)
// 功能: 三渠道 webhook 配置(DB 即时生效) / 测试发送 / 命令说明 / 回调地址展示
import { useCallback, useEffect, useState, type FC } from "react";
import { MessageSquare, Send, Save, RefreshCw, CheckCircle2, XCircle, Bot } from "lucide-react";

interface ImConfigState {
  feishuWebhook: string;
  dingtalkWebhook: string;
  telegramToken: string;
  telegramTokenSet: boolean;
  telegramChatId: string;
  wecomCorpId: string;
  wecomCorpSecret: string;
  wecomCorpSecretSet: boolean;
  wecomAgentId: string;
  wecomCallbackToken: string;
  wecomCallbackTokenSet: boolean;
  wecomEncodingAesKey: string;
  wecomEncodingAesKeySet: boolean;
  wecomWebhook: string;
  wecomTouser: string;
}
interface ImStatus { feishu: boolean; dingtalk: boolean; telegram: boolean; wecom: boolean; config?: { feishuWebhook?: string; dingtalkWebhook?: string; telegramConfigured?: boolean } }

const inputCls = "w-full rounded-md border border-white/10 bg-slate-800 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-primary/50 focus:outline-none";
const btnPrimary = "inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40";

export const ImPanel: FC = () => {
  const [cfg, setCfg] = useState<ImConfigState>({
    feishuWebhook: "", dingtalkWebhook: "", telegramToken: "", telegramTokenSet: false, telegramChatId: "",
    wecomCorpId: "", wecomCorpSecret: "", wecomCorpSecretSet: false, wecomAgentId: "",
    wecomCallbackToken: "", wecomCallbackTokenSet: false, wecomEncodingAesKey: "", wecomEncodingAesKeySet: false,
    wecomWebhook: "", wecomTouser: "",
  });
  const [status, setStatus] = useState<ImStatus | null>(null);
  const [testText, setTestText] = useState("MarxSphere IM 测试消息 ✅");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([
        fetch("/api/im/status").then((r) => r.json()),
        fetch("/api/im/config").then((r) => r.json()),
      ]);
      setStatus(s);
      const cc = c?.config || {};
      setCfg({
        feishuWebhook: cc.feishuWebhook || "",
        dingtalkWebhook: cc.dingtalkWebhook || "",
        telegramToken: cc.telegramToken || "",
        telegramTokenSet: !!cc.telegramTokenSet,
        telegramChatId: cc.telegramChatId || "",
        wecomCorpId: cc.wecomCorpId || "",
        wecomCorpSecret: cc.wecomCorpSecret || "",
        wecomCorpSecretSet: !!cc.wecomCorpSecretSet,
        wecomAgentId: cc.wecomAgentId || "",
        wecomCallbackToken: cc.wecomCallbackToken || "",
        wecomCallbackTokenSet: !!cc.wecomCallbackTokenSet,
        wecomEncodingAesKey: cc.wecomEncodingAesKey || "",
        wecomEncodingAesKeySet: !!cc.wecomEncodingAesKeySet,
        wecomWebhook: cc.wecomWebhook || "",
        wecomTouser: cc.wecomTouser || "",
      });
    } catch {}
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setBusy(true); setMsg("");
    try {
      const r = await fetch("/api/im/config", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          feishuWebhook: cfg.feishuWebhook,
          dingtalkWebhook: cfg.dingtalkWebhook,
          ...(cfg.telegramToken && !cfg.telegramToken.startsWith("••••") ? { telegramToken: cfg.telegramToken } : {}),
          telegramChatId: cfg.telegramChatId,
          wecomCorpId: cfg.wecomCorpId,
          ...(cfg.wecomCorpSecret && !cfg.wecomCorpSecret.startsWith("••••") ? { wecomCorpSecret: cfg.wecomCorpSecret } : {}),
          wecomAgentId: cfg.wecomAgentId,
          ...(cfg.wecomCallbackToken && !cfg.wecomCallbackToken.startsWith("••••") ? { wecomCallbackToken: cfg.wecomCallbackToken } : {}),
          ...(cfg.wecomEncodingAesKey && !cfg.wecomEncodingAesKey.startsWith("••••") ? { wecomEncodingAesKey: cfg.wecomEncodingAesKey } : {}),
          wecomWebhook: cfg.wecomWebhook,
          wecomTouser: cfg.wecomTouser,
        }),
      });
      const d = await r.json();
      setMsg(d.ok ? "✅ 配置已保存(即时生效)" : `⚠️ ${d?.error || "保存失败"}`);
      await load();
    } catch (e) { setMsg(String(e)); }
    finally { setBusy(false); }
  };

  const testSend = async () => {
    setBusy(true); setMsg("");
    try {
      const r = await fetch("/api/im/send", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: testText }),
      });
      const d = await r.json();
      const parts: string[] = [];
      if (d?.sent?.feishu) parts.push("飞书✅");
      if (d?.sent?.dingtalk) parts.push("钉钉✅");
      if (d?.sent?.telegram) parts.push("Telegram✅");
      setMsg(parts.length ? `✅ 已发送: ${parts.join(" ")}` : "⚠️ 未配置任何渠道(先保存 webhook 再测试)");
    } catch (e) { setMsg(String(e)); }
    finally { setBusy(false); }
  };

  const callbackUrl = (path: string) => `${window.location.origin}${path}`;

  return (
    <div className="space-y-3 p-4 text-sm">
      <div className="flex items-center gap-2">
        <MessageSquare className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-semibold">IM 接入</h2>
        <span className="rounded bg-primary/10 px-2 py-0.5 text-[10px] text-primary">飞书 / 钉钉 / Telegram 机器人远程对话</span>
      </div>

      {/* 渠道状态 */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {([
          ["飞书", status?.feishu, status?.config?.feishuWebhook || ""],
          ["钉钉", status?.dingtalk, status?.config?.dingtalkWebhook || ""],
          ["Telegram", status?.telegram, status?.config?.telegramConfigured ? "已配置" : ""],
          ["企业微信", status?.wecom, ""],
        ] as Array<[string, boolean | undefined, string]>).map(([name, ok, hint]) => (
          <div key={name} className={`rounded-lg border p-3 ${ok ? "border-emerald-400/30 bg-emerald-400/5" : "border-border/60 bg-card"}`}>
            <div className="flex items-center gap-2">
              {ok ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <XCircle className="h-4 w-4 text-muted-foreground" />}
              <span className="font-medium">{name}</span>
              <span className="ml-auto text-[10px] text-muted-foreground">{ok ? "已启用" : "未配置"}</span>
            </div>
            {hint && <div className="mt-1 truncate text-[10px] text-muted-foreground">{hint}</div>}
          </div>
        ))}
      </div>

      {/* 配置表单 */}
      <div className="rounded-lg border border-border/60 bg-card p-4">
        <div className="mb-3 flex items-center gap-2 font-medium"><Bot className="h-4 w-4" /> Webhook 配置(保存即时生效, 无需重启)</div>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-[11px] text-muted-foreground">飞书自定义机器人 Webhook</label>
            <input className={inputCls} placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/xxx" value={cfg.feishuWebhook}
              onChange={(e) => setCfg({ ...cfg, feishuWebhook: e.target.value })} />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-muted-foreground">钉钉机器人 Webhook</label>
            <input className={inputCls} placeholder="https://oapi.dingtalk.com/robot/send?access_token=xxx" value={cfg.dingtalkWebhook}
              onChange={(e) => setCfg({ ...cfg, dingtalkWebhook: e.target.value })} />
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-[11px] text-muted-foreground">Telegram Bot Token{cfg.telegramTokenSet ? "(已设置, 留空不修改)" : ""}</label>
              <input className={inputCls} placeholder="123456:ABC-DEF..." value={cfg.telegramToken}
                onChange={(e) => setCfg({ ...cfg, telegramToken: e.target.value })} />
            </div>
            <div>
              <label className="mb-1 block text-[11px] text-muted-foreground">Telegram Chat ID</label>
              <input className={inputCls} placeholder="chat_id 或 群 id" value={cfg.telegramChatId}
                onChange={(e) => setCfg({ ...cfg, telegramChatId: e.target.value })} />
            </div>
          </div>

          {/* 企业微信 */}
          <div className="rounded border border-emerald-400/20 bg-emerald-400/[0.03] p-3">
            <div className="mb-2 text-[11px] font-medium text-emerald-300">企业微信(自建应用双向: corpid + corpsecret → access_token → 发消息; 回调 AES 加解密)</div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-[11px] text-muted-foreground">Corp ID</label>
                <input className={inputCls} placeholder="企业微信 CorpID" value={cfg.wecomCorpId}
                  onChange={(e) => setCfg({ ...cfg, wecomCorpId: e.target.value })} />
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-muted-foreground">Corp Secret{cfg.wecomCorpSecretSet ? "(已设置, 留空不修改)" : ""}</label>
                <input className={inputCls} placeholder="自建应用 Secret" value={cfg.wecomCorpSecret} type="password"
                  onChange={(e) => setCfg({ ...cfg, wecomCorpSecret: e.target.value })} />
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-muted-foreground">Agent ID</label>
                <input className={inputCls} placeholder="自建应用 AgentId" value={cfg.wecomAgentId}
                  onChange={(e) => setCfg({ ...cfg, wecomAgentId: e.target.value })} />
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-muted-foreground">接收人 Touser(如 @all 或 userid)</label>
                <input className={inputCls} placeholder="@all" value={cfg.wecomTouser}
                  onChange={(e) => setCfg({ ...cfg, wecomTouser: e.target.value })} />
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-muted-foreground">回调 Token{cfg.wecomCallbackTokenSet ? "(已设置)" : ""}</label>
                <input className={inputCls} placeholder="接收消息服务器 Token" value={cfg.wecomCallbackToken}
                  onChange={(e) => setCfg({ ...cfg, wecomCallbackToken: e.target.value })} />
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-muted-foreground">EncodingAESKey(43 字符){cfg.wecomEncodingAesKeySet ? "(已设置)" : ""}</label>
                <input className={inputCls} placeholder="43 位 AES Key" value={cfg.wecomEncodingAesKey}
                  onChange={(e) => setCfg({ ...cfg, wecomEncodingAesKey: e.target.value })} />
              </div>
            </div>
            <div className="mt-2">
              <label className="mb-1 block text-[11px] text-muted-foreground">群机器人 Webhook(可选, 单向推送: 填此即用, 无需自建应用)</label>
              <input className={inputCls} placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx" value={cfg.wecomWebhook}
                onChange={(e) => setCfg({ ...cfg, wecomWebhook: e.target.value })} />
            </div>
          </div>
        </div>
        <div className="mt-4 flex gap-2">
          <button type="button" onClick={save} disabled={busy} className={btnPrimary}><Save className="h-3.5 w-3.5" /> 保存配置</button>
          <button type="button" onClick={() => void load()} disabled={busy} className="inline-flex items-center gap-1 rounded-md border border-border/60 px-3 py-1.5 text-xs hover:bg-muted"><RefreshCw className="h-3 w-3" /> 刷新</button>
          <button type="button" onClick={async () => { setBusy(true); setMsg(""); try { const r = await fetch("/api/im/wecom/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "webhook", content: testText }) }); const d = await r.json(); setMsg(d.ok ? "✅ 企业微信群机器人已发送" : `⚠️ ${d?.error || "发送失败"}`); } catch (e) { setMsg(String(e)); } finally { setBusy(false); } }} disabled={busy}
            className="inline-flex items-center gap-1 rounded-md border border-emerald-400/40 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-400/10">测试群机器人</button>
          <button type="button" onClick={async () => { setBusy(true); setMsg(""); try { const r = await fetch("/api/im/wecom/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "app", content: testText }) }); const d = await r.json(); setMsg(d.ok ? "✅ 企业微信自建应用已发送" : `⚠️ ${d?.error || "发送失败"}`); } catch (e) { setMsg(String(e)); } finally { setBusy(false); } }} disabled={busy}
            className="inline-flex items-center gap-1 rounded-md border border-emerald-400/40 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-400/10">测试自建应用</button>
          {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
        </div>
      </div>

      {/* 测试发送 + 回调地址 */}
      <div className="rounded-lg border border-border/60 bg-card p-4">
        <div className="mb-3 flex items-center gap-2 font-medium"><Send className="h-4 w-4" /> 测试发送(全部已配渠道)</div>
        <div className="flex gap-2">
          <input className={inputCls} value={testText} onChange={(e) => setTestText(e.target.value)} />
          <button type="button" onClick={testSend} disabled={busy} className={btnPrimary + " shrink-0"}>发送测试</button>
        </div>
        <div className="mt-3 space-y-1 rounded bg-muted/30 p-2 text-[11px] text-muted-foreground">
          <div className="font-medium text-foreground/80">回调地址(在对应平台机器人配置里填写):</div>
          <div className="font-mono">飞书: {callbackUrl("/api/im/feishu")}</div>
          <div className="font-mono">钉钉: {callbackUrl("/api/im/dingtalk")}</div>
          <div className="font-mono">Telegram: {callbackUrl("/api/im/telegram")}</div>
          <div className="font-mono">企业微信(自建应用): {callbackUrl("/api/im/wecom")}(URL 验证 + 消息回调)</div>
          <div className="mt-1">配置后向机器人发送消息即可远程对话; 支持命令: 状态 / 项目 / 评测 / 审批 / 告警 / 帮助</div>
        </div>
      </div>
    </div>
  );
};
