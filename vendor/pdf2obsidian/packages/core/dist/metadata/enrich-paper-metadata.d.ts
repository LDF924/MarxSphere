import type { MetadataConfig, PaperMetadata } from '../config/types.js';
type MetadataPatch = {
    [Key in keyof PaperMetadata]?: PaperMetadata[Key] | undefined;
};
export interface MetadataEnrichmentResult {
    metadata: PaperMetadata;
    sources: string[];
    warnings: string[];
    cacheHits: string[];
}
export declare function enrichPaperMetadata(input: {
    metadata: PaperMetadata;
    config: MetadataConfig;
}): Promise<MetadataEnrichmentResult>;
export declare function mergeMetadata(base: PaperMetadata, next: MetadataPatch): PaperMetadata;
export {};
