// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// policy-service.ts — 中国政府网政策检索
// 通过已注册的 gov-cn-policy MCP（China-Central-Policy-MCP）检索
// 用 spawn + stdin 标准握手（initialize → tools/call）
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const MCP_ENTRY = process.env.POLICY_MCP_ENTRY || "China-Central-Policy-MCP/build/index.js";

export interface PolicyItem {
  title: string;
  url: string;
  date: string;
  level: string;
  summary?: string;
  category?: string;
}

export interface PolicySearchResult {
  count: number;
  items: PolicyItem[];
  error?: string;
}

/** 通过 stdio 调用 MCP 的一个工具（spawn + 标准握手） */
async function callMcpTool(toolName: string, args: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [MCP_ENTRY], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    let output = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error("MCP 调用超时"));
      }
    }, 30_000);

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
      // 尝试解析含 result 的行
      const lines = output.split("\n").filter((l) => l.trim().startsWith("{"));
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          // 只在有 content 文本时 resolve（tools/call 响应）；initialize 的 result 跳过
          if (msg.result?.content?.[0]?.text && !settled) {
            settled = true;
            clearTimeout(timer);
            resolve(JSON.parse(msg.result.content[0].text));
            child.kill();
            return;
          }
          if (msg.error && !settled) {
            settled = true;
            clearTimeout(timer);
            reject(new Error(`MCP 错误: ${msg.error.message ?? JSON.stringify(msg.error)}`));
            child.kill();
            return;
          }
        } catch {
          // 行不完整或非 JSON，继续累积
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("close", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(stderr.slice(0, 200) || "MCP 进程提前退出"));
      }
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    // 握手：initialize → initialized → tools/call
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "marxsphere", version: "1.0" } }
    }) + "\n");

    setTimeout(() => {
      if (!settled) {
        child.stdin.write(JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized"
        }) + "\n");
        child.stdin.write(JSON.stringify({
          jsonrpc: "2.0",
          id: randomUUID(),
          method: "tools/call",
          params: { name: toolName, arguments: args }
        }) + "\n");
      }
    }, 300);
  });
}

async function searchGovPolicies(input: {
  keyword: string;
  pageSize?: number;
  startdate?: string;
  enddate?: string;
}): Promise<PolicySearchResult> {
  const keyword = input.keyword.trim();
  if (!keyword) return { count: 0, items: [] };

  try {
    const data = await callMcpTool("get_latest_policies", {
      keyword,
      limit: input.pageSize ?? 10,
      startdate: input.startdate,
      enddate: input.enddate
    });

    const items: PolicyItem[] = Array.isArray(data?.items)
      ? data.items.map((item: any) => ({
          title: String(item.title ?? ""),
          url: String(item.url ?? item.policy_id ?? ""),
          date: String(item.date ?? "").slice(0, 10),
          level: String(item.level ?? ""),
          summary: item.summary ? String(item.summary).slice(0, 200) : undefined,
          category: String(item.category ?? "")
        }))
      : [];
    return { count: items.length, items };
  } catch (error) {
    return {
      count: 0,
      items: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export const policyService = {
  search: searchGovPolicies
};
