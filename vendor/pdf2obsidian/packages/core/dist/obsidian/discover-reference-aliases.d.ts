import type { AutoLinkConfig } from '../config/types.js';
export interface ReferenceAliasDiscoveryResult {
    discoveredCount: number;
    aliases: Array<{
        alias: string;
        target: string;
        score: number;
    }>;
}
export declare function discoverReferenceAliases(input: {
    markdown: string;
    vaultPath: string;
    config: AutoLinkConfig;
    excludeTargets: string[];
}): Promise<ReferenceAliasDiscoveryResult>;
