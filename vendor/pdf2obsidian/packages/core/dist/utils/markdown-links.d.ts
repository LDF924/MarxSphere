interface RewriteMarkdownAssetLinksInput {
    markdown: string;
    noteDirRelativeToVaultRoot: string;
    noteFileName: string;
    assetRootFromVault: string;
}
export declare function rewriteMarkdownAssetLinks(input: RewriteMarkdownAssetLinksInput): string;
export {};
