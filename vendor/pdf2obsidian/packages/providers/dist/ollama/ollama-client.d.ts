import type { GenerateTextInput, TextGenerationClient, TextGenerationClientConfig } from '../types.js';
export declare class OllamaClient implements TextGenerationClient {
    private readonly config;
    private warmedUp;
    constructor(config: TextGenerationClientConfig);
    warmUp(): Promise<void>;
    generateText(input: GenerateTextInput): Promise<string>;
    private resolveBaseUrl;
}
