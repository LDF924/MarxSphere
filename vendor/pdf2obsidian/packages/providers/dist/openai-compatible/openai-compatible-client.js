export class OpenAICompatibleClient {
    config;
    constructor(config) {
        this.config = config;
    }
    async generateText(input) {
        const apiKey = this.resolveApiKey();
        if (!apiKey) {
            throw new Error('缺少 AI 服务 API Key，请配置 translation.apiKeyEnv 或 translation.apiKey。');
        }
        const url = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: this.config.model,
                messages: [
                    { role: 'system', content: input.systemPrompt },
                    { role: 'user', content: input.userPrompt }
                ],
                stream: false
            })
        });
        const payload = await parseResponse(response);
        if (!response.ok) {
            const detail = payload.error?.message ?? `HTTP ${response.status}`;
            throw new Error(`OpenAI 兼容服务请求失败：${detail}（url=${url}，model=${this.config.model}）`);
        }
        const content = payload.choices?.[0]?.message?.content?.trim();
        if (!content) {
            throw new Error(payload.error?.message ?? 'OpenAI 兼容服务返回了空内容');
        }
        return content;
    }
    resolveApiKey() {
        if (this.config.apiKey)
            return this.config.apiKey;
        if (this.config.apiKeyEnv)
            return process.env[this.config.apiKeyEnv];
        return undefined;
    }
}
async function parseResponse(response) {
    const body = await response.text();
    if (!body)
        return {};
    try {
        return JSON.parse(body);
    }
    catch {
        throw new Error(`OpenAI 兼容服务返回了非 JSON 响应：HTTP ${response.status} ${body.slice(0, 500)}`);
    }
}
