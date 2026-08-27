# 第三方模型接入（Model Neutrality）

MarxSphere 模型中立（2026-08-27）：不绑定单一订阅，支持任意 OpenAI 兼容 API、DeepSeek 原生、Anthropic 原生端点及自定义提供商。

## 支持的提供商

| 提供商 | 端点格式 | 配置 |
|---|---|---|
| **DeepSeek** | OpenAI 兼容 `/chat/completions` | `DEEPSEEK_API_KEY` 或 `LLM_BASE_URL=https://api.deepseek.com/v1` |
| **OpenAI / 兼容聚合**（302AI 等） | OpenAI 兼容 | `LLM_BASE_URL` + `LLM_API_KEY` + `LLM_MODEL` |
| **Anthropic Claude** | 原生 `/v1/messages`（自动识别） | `LLM_BASE_URL=https://api.anthropic.com/v1` + `LLM_API_KEY=sk-ant-...` |
| **阿里 DashScope** | OpenAI 兼容 | `LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1` |
| **Ollama 本地** | OpenAI 兼容 | `LLM_BASE_URL=http://localhost:11434/v1` |
| **任意自定义** | OpenAI 兼容或 Anthropic 原生 | 配 base_url + key + model 即可 |

## 自动端点识别（fetchLlm）

URL 含 `/messages`（非 `/chat/completions`）→ **Anthropic 格式**（`x-api-key` 头 + `anthropic-version` + `content:[{type:text}]` 解析）
否则 → **OpenAI 兼容格式**（`Authorization: Bearer` + `choices[0].message.content` 解析）

## 配置方式

### 环境变量（.env）
```bash
# DeepSeek 原生（优先）
DEEPSEEK_API_KEY=sk-xxx
DS_BASE_URL=https://api.deepseek.com/v1

# 或 OpenAI 兼容通用
LLM_BASE_URL=https://api.anthropic.com/v1   # Anthropic 原生
LLM_API_KEY=sk-ant-xxx
LLM_MODEL=claude-sonnet-4-8

# Embedding（独立）
EMBEDDING_BASE_URL=...
EMBEDDING_API_KEY=...
EMBEDDING_MODEL=...
```

### 界面配置（ai_provider_settings 表）
- 后端 `getRuntimeSettings()` 读 DB 表配置（llm_base_url/llm_api_key/llm_model）
- 表配置优先于环境变量默认值

### 角色模型选择（前端 LlmModelSelector）
按角色（reason/judge/review/plan/verify/strategy）独立选择模型，实时同步：
- DeepSeek V4 Pro / Flash
- 通义千问 3.7 Max / Plus
- **Claude Sonnet 4.8 / Opus 4.8 / Haiku 4.5**（Anthropic 端点）

## 注意事项

- **thinking 禁用**：DeepSeek 结构化输出必须 `thinking: {type:"disabled"}`（否则 finish_reason=length content 为空）
- **模型中立测试**：`test/model-neutrality.test.ts`（端点识别 4 例）
- 模型注册表：`src/services/llm-model-registry.ts`（新增模型在此登记后前端可选）
