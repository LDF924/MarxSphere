export interface MarkdownChunk {
    index: number;
    headingPath: string[];
    content: string;
}
/**
 * 将 Markdown 文本分割成多个块
 * @param markdown 输入的 Markdown 文本
 * @param chunkCharLimit 每个块的最大字符数
 * @returns 分割后的 Markdown 块数组
 */
export declare function chunkMarkdown(markdown: string, chunkCharLimit: number): MarkdownChunk[];
