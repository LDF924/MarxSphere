-- 079_chat_sessions.sql — AI 对话页（ChatPanel）支持
-- 复用 mcp_sessions/mcp_messages/mcp_tool_calls 三表存储通用对话会话；
-- kind 列区分「项目绑定会话」(project，ProjectRail/MCP 工具对话用) 与「通用 AI 对话」(chat，AI 对话页用)
-- images 列存用户消息附带图片的相对路径（data/agent_workspace/chat_uploads/ 下，base64 不入库）

alter table mcp_sessions add column if not exists kind text not null default 'project';

create index if not exists idx_mcp_sessions_kind on mcp_sessions (tenant_id, kind, updated_at desc);

alter table mcp_messages add column if not exists images jsonb;
