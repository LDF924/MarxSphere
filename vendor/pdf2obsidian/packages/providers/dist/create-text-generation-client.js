import { OllamaClient } from './ollama/ollama-client.js';
import { OpenAICompatibleClient } from './openai-compatible/openai-compatible-client.js';
export function createTextGenerationClient(config) {
    switch (config.provider) {
        case 'ollama':
            return new OllamaClient(config);
        case 'openai-compatible':
            return new OpenAICompatibleClient(config);
    }
}
