export interface QualityReport {
    status: 'completed' | 'needs_review';
    warnings: string[];
    metrics: {
        originalHeadingCount: number;
        translatedHeadingCount: number;
        originalImageCount: number;
        translatedImageCount: number;
        missingImages: string[];
        translatedChunkCount: number;
        cacheHitCount: number;
        translationSkipped: boolean;
        detectedSourceLanguage: string;
        autoLinkedReferenceCount: number;
        discoveredReferenceAliasCount: number;
        metadataFieldCount: number;
        metadataSources: string[];
        metadataCacheHits: string[];
        readingAssetCount: number;
        readingAssetCacheHitCount: number;
    };
}
export declare function createQualityReport(input: {
    originalNotePath: string;
    translatedNotePath: string;
    originalNote: string;
    translatedNote: string;
    translatedChunks: Array<{
        cacheHit: boolean;
    }>;
    translationSkipped: boolean;
    detectedSourceLanguage: string;
    autoLinkedReferenceCount: number;
    discoveredReferenceAliasCount: number;
    metadataFieldCount: number;
    metadataSources: string[];
    metadataWarnings: string[];
    metadataCacheHits: string[];
    readingAssets: Array<{
        cacheHit: boolean;
        warnings: string[];
    }>;
    reportPath: string;
}): Promise<QualityReport>;
