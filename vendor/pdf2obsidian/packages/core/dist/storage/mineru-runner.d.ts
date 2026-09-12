export interface RunMineruInput {
    pdfPath: string;
    outputDir: string;
    command: string;
    mode: 'cli' | 'local' | 'remote' | 'managed' | 'official';
    backend: 'pipeline' | 'vlm-http-client' | 'hybrid-http-client' | 'vlm-auto-engine' | 'hybrid-auto-engine';
    method?: 'auto' | 'txt' | 'ocr' | undefined;
    apiUrl?: string | undefined;
    apiTokenEnv?: string | undefined;
    modelVersion?: 'pipeline' | 'vlm' | undefined;
    modelSource?: string | undefined;
    formula?: boolean | undefined;
    table?: boolean | undefined;
    imageAnalysis?: boolean | undefined;
}
export declare function runMineru(input: RunMineruInput): Promise<void>;
export declare function findPrimaryMarkdown(rootDir: string, preferredStem: string): Promise<string>;
