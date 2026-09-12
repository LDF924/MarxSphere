import type { TranslationConfig } from '../config/types.js';
export interface TranslateMarkdownResult {
    markdown: string;
    chunks: Array<{
        index: number;
        headingPath: string[];
        cacheHit: boolean;
        charCount: number;
    }>;
}
export declare function translateMarkdownInChunks(input: {
    markdown: string;
    title: string;
    config: TranslationConfig;
}): Promise<TranslateMarkdownResult>;
