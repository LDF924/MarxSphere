export type MarkdownLanguage = 'zh-CN' | 'en' | 'unknown';
export interface MarkdownLanguageDetection {
    language: MarkdownLanguage;
    hanRatio: number;
    hanCount: number;
    latinCount: number;
}
export declare function detectMarkdownLanguage(markdown: string): MarkdownLanguageDetection;
