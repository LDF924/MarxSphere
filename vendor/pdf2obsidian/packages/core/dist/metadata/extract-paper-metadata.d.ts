import type { MetadataConfig, PaperMetadata } from '../config/types.js';
export interface ExtractPaperMetadataInput {
    markdown: string;
    title: string;
    slug: string;
    pdfPath: string;
    config: MetadataConfig;
}
export declare function extractPaperMetadata(input: ExtractPaperMetadataInput): PaperMetadata;
export declare function applyPaperMetadataOverride(input: {
    metadata: PaperMetadata;
    slug: string;
    pdfPath: string;
    config: MetadataConfig;
}): PaperMetadata;
export declare function createPaperFrontmatter(metadata: PaperMetadata): Record<string, unknown>;
