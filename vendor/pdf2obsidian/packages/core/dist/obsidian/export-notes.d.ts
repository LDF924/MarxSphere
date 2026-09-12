import type { AppConfig } from '../config/types.js';
export interface ExportNotesInput {
    config: AppConfig;
    slug: string;
    pdfPath: string;
    originalNote: string | undefined;
    translatedNote: string;
    indexNote: string;
    documentRoot: string;
}
export interface ExportNotesResult {
    originalNotePath?: string | undefined;
    translatedNotePath: string;
    indexNotePath: string;
}
export declare function exportNotes(input: ExportNotesInput): Promise<ExportNotesResult>;
