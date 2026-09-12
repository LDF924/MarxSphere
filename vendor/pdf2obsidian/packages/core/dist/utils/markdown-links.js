import { dirname, posix, relative } from 'node:path';
const markdownImagePattern = /(!\[[^\]]*]\()([^)]+)(\))/g;
export function rewriteMarkdownAssetLinks(input) {
    const noteDir = input.noteDirRelativeToVaultRoot;
    const notePath = posix.join(noteDir.replaceAll('\\', '/'), input.noteFileName);
    const noteFolder = dirname(notePath);
    const assetRoot = input.assetRootFromVault.replaceAll('\\', '/');
    return input.markdown.replace(markdownImagePattern, (_, prefix, rawPath, suffix) => {
        if (isExternalOrAnchor(rawPath)) {
            return `${prefix}${rawPath}${suffix}`;
        }
        const normalizedRawPath = rawPath.replaceAll('\\', '/').replace(/^\.?\/*/, '');
        const assetRelativePath = normalizedRawPath.startsWith('images/')
            ? normalizedRawPath.slice('images/'.length)
            : normalizedRawPath;
        const normalizedAssetTarget = posix.join(assetRoot, assetRelativePath);
        const relativePath = relative(noteFolder, normalizedAssetTarget).replaceAll('\\', '/');
        return `${prefix}${relativePath}${suffix}`;
    });
}
function isExternalOrAnchor(path) {
    return path.startsWith('http://') ||
        path.startsWith('https://') ||
        path.startsWith('data:') ||
        path.startsWith('#');
}
