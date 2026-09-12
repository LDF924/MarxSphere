import type { AppConfig } from '@pdf2obsidian/core';
export interface ImportPdfInput {
    pdfPath: string;
    config: AppConfig;
    onStep?: ImportPipelineStepCallback | undefined;
    /** 已完成阶段集合，用于断点续跑时跳过已成功的阶段 */
    completedSteps?: Set<ImportPipelineStep> | undefined;
}
export type ImportPipelineStep = 'upload' | 'mineru' | 'normalize' | 'translate' | 'obsidian_export' | 'quality_check';
export type ImportPipelineStepStatus = 'running' | 'completed' | 'failed' | 'skipped';
export type ImportPipelineStepCallback = (event: {
    step: ImportPipelineStep;
    status: ImportPipelineStepStatus;
    message?: string | undefined;
}) => Promise<void> | void;
export declare const importPipelineSteps: readonly ["upload", "mineru", "normalize", "translate", "obsidian_export", "quality_check"];
export interface ImportPdfResult {
    sourceHash: string;
    slug: string;
    originalNotePath: string;
    translatedNotePath: string;
    indexNotePath: string;
    databaseNotePath?: string | undefined;
    referenceStubCount?: number | undefined;
    configSummary?: {
        mineruMode: string;
        mineruBackend: string;
        translationEnabled: boolean;
        translationSkipped: boolean;
        translationProvider?: string;
        translationModel?: string;
        readingAssetsEnabled: boolean;
    } | undefined;
}
export declare function importPdf(input: ImportPdfInput): Promise<ImportPdfResult>;
