// startup-check.ts — 启动环境检查（V407: 边界健壮性）
// 服务启动时检查关键配置，缺失/异常给出明确警告（而非静默空库/报错），不阻断启动
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

interface CheckResult { name: string; ok: boolean; detail: string }

function dirExists(p: string): boolean {
  try { return fs.existsSync(p) && fs.statSync(p).isDirectory(); } catch { return false; }
}

function checks(): CheckResult[] {
  const results: CheckResult[] = [];

  // 1. 密钥配置
  const llmKey = process.env.LLM_API_KEY;
  if (!llmKey) {
    results.push({ name: "LLM_API_KEY", ok: false, detail: "未配置 — 推理/Agent/对话将不可用，请在 .env 配置" });
  } else {
    results.push({ name: "LLM_API_KEY", ok: true, detail: "已配置" });
  }
  const embKey = process.env.EMBEDDING_API_KEY;
  if (!embKey) {
    results.push({ name: "EMBEDDING_API_KEY", ok: false, detail: "未配置 — 向量检索不可用（Ask/推理检索不到结果），请在 .env 配置" });
  } else {
    results.push({ name: "EMBEDDING_API_KEY", ok: true, detail: "已配置" });
  }

  // 1.2 Rerank（V412: 重排检索结果，未配置时检索融合仍可用但无重排）
  const rerankModel = process.env.RERANK_MODEL;
  const rerankBase = process.env.RERANK_BASE_URL;
  if (!rerankModel || !rerankBase) {
    results.push({ name: "RERANK", ok: false, detail: "未完整配置（RERANK_MODEL/RERANK_BASE_URL）— 检索结果不做 LLM 重排（功能降级，不影响基础检索）。建议在 .env 配置：RERANK_MODEL=qwen3-rerank + RERANK_BASE_URL=https://dashscope.aliyuncs.com" });
  } else {
    results.push({ name: "RERANK", ok: true, detail: `已配置（${rerankModel}）` });
  }

  // 1.5 JWT_SECRET（V410: 生产暴露必须设置 — 未设时用随机密钥，重启后 Web 会话全部失效）
  if (!process.env.JWT_SECRET) {
    results.push({ name: "JWT_SECRET", ok: false, detail: "未配置 — 使用随机密钥（重启后登录会话失效）。生产部署必须设置（openssl rand -hex 32），否则每次重启所有用户需重新登录" });
  } else if ((process.env.JWT_SECRET || "").length < 32) {
    results.push({ name: "JWT_SECRET", ok: false, detail: "强度不足（当前 <32 字符）— 建议 openssl rand -hex 32 生成强随机值" });
  } else {
    results.push({ name: "JWT_SECRET", ok: true, detail: "已配置（强度 OK）" });
  }

  // 2. 数据库（DATABASE_URL 是否存在即可，连通性由 /health 报告）
  if (!process.env.DATABASE_URL) {
    results.push({ name: "DATABASE_URL", ok: false, detail: "未配置 — 服务无法启动，请在 .env 配置" });
  } else {
    results.push({ name: "DATABASE_URL", ok: true, detail: "已配置" });
  }

  // 3. 文献库/政策库/资料库目录（缺失 → 页面为空，给明确提示）
  const litDir = process.env.LITERATURE_DIR || path.join(os.homedir(), "1.Obsidian Vault", "课题文献库（CSSCI、北大核心、CSCD、AMI、WJCI）", "学术期刊");
  results.push(dirExists(litDir)
    ? { name: "LITERATURE_DIR", ok: true, detail: litDir }
    : { name: "LITERATURE_DIR", ok: false, detail: `目录不存在: ${litDir} — 文献库页面将为空。可在 .env 设置 LITERATURE_DIR 指向实际文献目录（见 .env.example）` });

  const polDir = process.env.POLICY_DIR || path.join(os.homedir(), "1.Obsidian Vault", "课题研究", "1.农业农村现代化进程中规范与引导工商资本路径研究", "著作、政策、会议");
  results.push(dirExists(polDir)
    ? { name: "POLICY_DIR", ok: true, detail: polDir }
    : { name: "POLICY_DIR", ok: false, detail: `目录不存在: ${polDir} — 政策库页面将为空。可在 .env 设置 POLICY_DIR（见 .env.example）` });

  const vaultRoot = process.env.VAULT_ROOT || path.join(os.homedir(), "1.Obsidian Vault");
  results.push(dirExists(vaultRoot)
    ? { name: "VAULT_ROOT", ok: true, detail: vaultRoot }
    : { name: "VAULT_ROOT", ok: false, detail: `目录不存在: ${vaultRoot} — 资料库页面将为空。可在 .env 设置 VAULT_ROOT（见 .env.example）` });

  return results;
}

/** 打印启动检查报告（不阻断启动；关键缺失给出醒目警告） */
export function runStartupChecks(): void {
  try {
    const results = checks();
    const failures = results.filter((r) => !r.ok);
    console.log("");
    console.log("═══ 启动环境检查 ═══");
    for (const r of results) {
      console.log(`  ${r.ok ? "✅" : "⚠️"} ${r.name}: ${r.detail}`);
    }
    if (failures.length > 0) {
      console.log(`⚠️ ${failures.length} 项配置缺失/异常 — 相关功能可能不可用（见上方详情，不影响服务启动）`);
      console.log("   配置参考: .env.example 底部（Obsidian 路径）与各 API Key 项");
    } else {
      console.log("✅ 全部配置正常");
    }
    console.log("═══ 检查结束 ═══");
    console.log("");
  } catch (err) {
    // 检查本身失败不阻断启动
    console.error("[startup-check] 检查失败（忽略）:", err instanceof Error ? err.message : String(err));
  }
}
