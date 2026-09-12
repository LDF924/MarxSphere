export type PdfSourceType = 'local' | 'arxiv' | 'doi' | 'url';
export interface ResolvedPdfSource {
    /** 下载到本地后的 PDF 文件绝对路径 */
    pdfPath: string;
    /** 输入源的类型 */
    sourceType: PdfSourceType;
    /** 提取到的 arXiv ID（仅 arxiv 类型） */
    arxivId?: string;
    /** 提取到的 DOI（仅 doi 类型） */
    doi?: string;
    /** 原始输入字符串 */
    originalInput: string;
}
/**
 * 将用户输入（本地路径、arXiv ID、DOI 或 PDF URL）解析为本地 PDF 文件路径。
 * 远程源会下载到 outputDir 目录中。
 */
export declare function resolvePdfSource(input: string, outputDir: string): Promise<ResolvedPdfSource>;
