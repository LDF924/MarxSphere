// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// concurrency.ts — P1: centralized p-limit controllers for PG and MCP
// PG max 2 concurrent queries, Cognee MCP max 3, Graphiti MCP max 3
import pLimit from "p-limit";
import type { RichMcpClientConfig } from "../ai/rich-mcp-client.js";

export const pgLimit = pLimit(2);
export const cogneeMcpLimit = pLimit(3);
export const graphitiMcpLimit = pLimit(3);

export function cogneeMcpConfig(): Partial<RichMcpClientConfig> {
  return { concurrencyLimit: (fn) => cogneeMcpLimit(fn) };
}

export function graphitiMcpConfig(): Partial<RichMcpClientConfig> {
  return { concurrencyLimit: (fn) => graphitiMcpLimit(fn) };
}
