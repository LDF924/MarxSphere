import type { ReadingAssetsConfig, TranslationConfig } from '../config/types.js';
export interface GenerateReadingAssetsInput {
    slug: string;
    title: string;
    translatedTitle: string;
    originalMarkdown: string;
    translatedMarkdown: string;
    documentRoot: string;
    translationConfig: TranslationConfig;
    config: ReadingAssetsConfig;
    sourceHash: string;
    createdAt: string;
}
export interface ReadingAssetResult {
    kind: ReadingAssetKind;
    path: string;
    cacheHit: boolean;
    warnings: string[];
}
export type ReadingAssetKind = 'summary' | 'terms' | 'qa';
/**
 * 生成阅读材料
 * @param input 生成阅读材料的输入
 * @returns 生成阅读材料的结果
 */
export declare function generateReadingAssets(input: GenerateReadingAssetsInput): Promise<ReadingAssetResult[]>;
