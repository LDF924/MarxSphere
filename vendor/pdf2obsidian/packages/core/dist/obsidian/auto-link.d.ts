import type { AutoLinkConfig } from '../config/types.js';
export interface AutoLinkResult {
    markdown: string;
    links: AutoLinkedReference[];
}
export interface AutoLinkedReference {
    text: string;
    target: string;
}
export declare function autoLinkMarkdown(input: {
    markdown: string;
    vaultPath: string;
    config: AutoLinkConfig;
    excludeTargets: string[];
}): Promise<AutoLinkResult>;
