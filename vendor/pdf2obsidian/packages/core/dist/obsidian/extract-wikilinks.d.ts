export interface ExtractedWikiLink {
    text: string;
    target: string;
}
export declare function extractWikiLinksFromMarkdown(input: {
    markdown: string;
    excludeTargets?: string[];
}): ExtractedWikiLink[];
export declare function normalizeWikiTarget(target: string): string;
