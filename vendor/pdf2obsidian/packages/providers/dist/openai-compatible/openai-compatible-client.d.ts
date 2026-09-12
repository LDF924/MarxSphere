import type { GenerateTextInput, TextGenerationClient, TextGenerationClientConfig } from '../types.js';
export declare class OpenAICompatibleClient implements TextGenerationClient {
    private readonly config;
    constructor(config: TextGenerationClientConfig);
    generateText(input: GenerateTextInput): Promise<string>;
    private resolveApiKey;
}
