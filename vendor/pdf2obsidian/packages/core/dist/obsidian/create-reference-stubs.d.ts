import type { StructuredReference } from './extract-structured-references.js';
export interface ReferenceStubResult {
    /** 创建的桩笔记数量 */
    createdCount: number;
    /** 已存在而跳过的数量 */
    skippedCount: number;
    /** 创建的桩笔记路径列表 */
    createdPaths: string[];
}
/**
 * 为结构化参考文献创建桩笔记（stub note）。
 * 桩笔记包含基本元数据 frontmatter 和被引用论文的反向链接。
 * 如果 vault 中已有匹配标题的笔记则跳过。
 */
export declare function createReferenceStubs(input: {
    references: StructuredReference[];
    citingPaperSlug: string;
    citingPaperTitle: string;
    vaultPath: string;
    documentDir: string;
    excludeTargets: string[];
}): Promise<ReferenceStubResult>;
