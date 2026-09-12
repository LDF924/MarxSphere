import type { JournalMetricsConfig, PaperMetadata } from '../config/types.js';
type MetadataPatch = {
    [Key in keyof PaperMetadata]?: PaperMetadata[Key] | undefined;
};
type LookupStatus = 'found' | 'missing';
export interface StoredJournalMetrics {
    metadata: MetadataPatch | undefined;
    publicationName: string;
    status: LookupStatus;
}
export declare function getStoredJournalMetrics(config: JournalMetricsConfig, publicationName: string): Promise<StoredJournalMetrics | undefined>;
export declare function upsertJournalMetrics(config: JournalMetricsConfig, publicationName: string, metadata: MetadataPatch | undefined): Promise<void>;
export {};
