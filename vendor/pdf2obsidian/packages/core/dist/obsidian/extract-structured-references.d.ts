export interface StructuredReference {
    /** 参考文献标题 */
    title: string;
    /** 作者列表（已拆分为独立姓名） */
    authors: string[];
    /** 发表年份 */
    year?: number;
    /** DOI */
    doi?: string;
    /** arXiv ID */
    arxivId?: string;
    /** 期刊/会议名称（启发式提取） */
    venue?: string;
    /** 原文中的完整引用行 */
    rawText: string;
}
/**
 * 从 Markdown 正文中提取结构化参考文献信息。
 * 支持编号列表格式（如 [1]、1.、1)）和冒号分隔的作者-标题模式。
 * 在标题和年份基础上，额外提取 DOI、arXiv ID、作者列表和期刊名。
 */
export declare function extractStructuredReferences(markdown: string): StructuredReference[];
