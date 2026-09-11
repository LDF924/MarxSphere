// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// startup-check.ts — 启动环境检查（V407: 边界健壮性）
// 服务启动时检查关键配置，缺失/异常给出明确警告（而非静默空库/报错），不阻断启动
import fs from "node:fs";
import { describeKbAvailability } from "./services/kb-paths.js";
import { clusterInstanceCount } from "./services/rate-limiter.js";

interface CheckResult { name: string; ok: boolean; detail: string }

/**
 * 认证强制模式。REQUIRE_AUTH 没配时: 非开发环境(NODE_ENV!=development)默认开,
 * 开发环境默认关 —— 单机跑 `npx tsx src/index.ts` 的人不该被密钥检查拦住。
 */
export function requireAuthEnabled(): boolean {
  const raw = process.env.REQUIRE_AUTH;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return (process.env.NODE_ENV || "development") !== "development";
}

/** 本轮检查里是否存在"致命项"(目前只有强制模式下的 JWT_SECRET 缺失) */
export function hasFatalConfigIssue(): boolean {
  return !process.env.JWT_SECRET && requireAuthEnabled();
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

  // 1.5 JWT_SECRET（V410: 生产暴露必须设置 — 未设时用随机密钥）
  //    多副本: 每个副本随机生成 → 互相验不过对方的 token, 表现为**随机 401**（无状态负载均衡下随机掉线）。
  //    单机: 只是重启后所有人重新登录。以前只告警不阻断, 上云必坏, 现在由 REQUIRE_AUTH 决定是否阻断。
  if (!process.env.JWT_SECRET) {
    // ok 恒为 false(它确实是缺失项, 图标要如实显示 ⚠️); 是否**致命**另算 ——
    // 只有强制认证模式下才拒绝启动。
    results.push({
      name: "JWT_SECRET",
      ok: false,
      detail: requireAuthEnabled()
        ? `未配置且 REQUIRE_AUTH 生效 — 多副本下各副本随机生成密钥会导致互相 401, 将拒绝启动。`
          + `请设置 JWT_SECRET=<openssl rand -hex 32 的输出>（单机开发可设 REQUIRE_AUTH=0 跳过）`
        : "未配置 — 使用随机密钥（重启后登录会话失效）。生产/多副本部署必须设置（openssl rand -hex 32）",
    });
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

  // 3. 知识库(资料库/文献库/政策库)目录
  //    路径解析与三套服务共用 kb-paths —— 否则自检说"存在"、服务却读不到(历史上就是三处默认值互不一致)。
  //    云端(容器/NAS)通常没有 ~/1.Obsidian Vault, 这里明确报"未挂载"而不是让用户以为是路径写错。
  const kb = describeKbAvailability();
  results.push(kb.ok
    ? { name: "知识库", ok: true, detail: kb.detail }
    : { name: "知识库", ok: false, detail: kb.detail });

  // 4. 部署形态: 逐项写明"共享还是本机"。
  //    这一节存在的意义是**防静默降级** —— 多副本部署时, 数据根/限流/对象存储只要有一项是本机态,
  //    就会出现"配额变 N 倍""图在别的副本上读不到"这类只在多副本下暴露的问题。
  //
  //    实例数来源: 量到的(clusterInstanceCount, 后端心跳)优先于声明的(REPLICA_COUNT) ——
  //    上一轮用环境变量, 但"忘记声明"是常态, 一个可选开关解决不了一个必现的风险。
  //    启动这一瞬间还没量到(探测在服务起来之后), 所以这里两种来源都看, 并写明用的是哪个。
  const declared = Number(process.env.REPLICA_COUNT) || 0;
  const measured = clusterInstanceCount();
  const replicas = Math.max(declared, measured, 1);
  const replicaSource = measured > declared ? `实测${measured}` : declared > 1 ? `声明${declared}` : "单实例";
  const shared = [
    { name: "数据根", local: !process.env.DATA_DIR, hint: "多副本请设 DATA_DIR 指向共享卷" },
    { name: "对象存储", local: !process.env.BLOB_DRIVER || process.env.BLOB_DRIVER === "local", hint: "多副本请设 BLOB_DRIVER=s3" },
    { name: "限流后端", local: !process.env.REDIS_URL && !process.env.DATABASE_URL, hint: "多副本请配 REDIS_URL 或 DATABASE_URL" },
  ];
  const localOnes = shared.filter((s) => s.local);
  const shapeDetail = `部署形态(${replicaSource}): ` + shared.map((s) => `${s.name}=${s.local ? "本机" : "共享"}`).join(" / ");
  // 单实例: 信息行; 已知多副本却仍有本机项: 真告警
  results.push(replicas > 1 && localOnes.length > 0
    ? { name: "部署形态", ok: false, detail: `${shapeDetail} — 但仍有本机项: ${localOnes.map((l) => `${l.name}(${l.hint})`).join("; ")}` }
    : { name: "部署形态", ok: true, detail: shapeDetail + (localOnes.length ? "(单实例形态; 多副本需改为共享)" : "") });

  return results;
}

/**
 * 打印启动检查报告。默认**不阻断启动**（关键缺失给醒目警告）；
 * 例外: 强制认证模式下 JWT_SECRET 缺失 → 拒绝启动（多副本互相 401 是必坏项，不是降级项）。
 */
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
      // 仅 JWT_SECRET 在强制模式下是致命项
      const jwtFatal = hasFatalConfigIssue();
      console.log(jwtFatal
        ? `❌ ${failures.length} 项配置缺失/异常 — 其中 JWT_SECRET 为强制项, 拒绝启动`
        : `⚠️ ${failures.length} 项配置缺失/异常 — 相关功能可能不可用（见上方详情，不影响服务启动）`);
      console.log("   配置参考: .env.example（知识库路径 / P2O 路径 / 各 API Key 项）");
      if (jwtFatal) {
        console.log("═══ 检查结束 ═══");
        console.log("");
        process.exit(1);
      }
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
