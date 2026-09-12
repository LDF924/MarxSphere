import type { PaperMetadata } from '../config/types.js';
export interface CitationFormats {
    citationPlain?: string | undefined;
    citationApa?: string | undefined;
    citationIeee?: string | undefined;
    citationBibtex?: string | undefined;
}
export declare function createCitationFormats(metadata: PaperMetadata): CitationFormats;
