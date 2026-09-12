import { dirname, join } from 'node:path';
import YAML from 'yaml';
import { pathExists, writeJsonFile } from '../storage/file-system.js';
export async function createQualityReport(input) {
    const warnings = [];
    // 质量报告不改变用户产物，只把结构差异和外部服务告警沉淀成机器可读 JSON。
    const originalHeadingCount = countHeadings(input.originalNote);
    const translatedHeadingCount = countHeadings(input.translatedNote);
    const originalImageRefs = extractImageRefs(input.originalNote);
    const translatedImageRefs = extractImageRefs(input.translatedNote);
    const missingImages = [
        ...(await findMissingImages(input.originalNotePath, originalImageRefs)),
        ...(await findMissingImages(input.translatedNotePath, translatedImageRefs))
    ];
    validateFrontmatter(input.originalNote, 'original', warnings);
    validateFrontmatter(input.translatedNote, 'translated', warnings);
    // metadata/reading 的 warning 统一汇入报告，UI 可以直接显示“需要检查”的原因。
    warnings.push(...input.metadataWarnings.map((warning) => `Metadata warning: ${warning}`));
    warnings.push(...input.readingAssets.flatMap((asset) => asset.warnings.map((warning) => `Reading asset warning: ${warning}`)));
    if (originalHeadingCount !== translatedHeadingCount) {
        warnings.push(`Heading count mismatch: original=${originalHeadingCount}, translated=${translatedHeadingCount}`);
    }
    if (originalImageRefs.length !== translatedImageRefs.length) {
        warnings.push(`Image count mismatch: original=${originalImageRefs.length}, translated=${translatedImageRefs.length}`);
    }
    if (missingImages.length > 0) {
        warnings.push(`Missing image files: ${missingImages.length}`);
    }
    const report = {
        status: warnings.length > 0 ? 'needs_review' : 'completed',
        warnings,
        metrics: {
            originalHeadingCount,
            translatedHeadingCount,
            originalImageCount: originalImageRefs.length,
            translatedImageCount: translatedImageRefs.length,
            missingImages,
            translatedChunkCount: input.translatedChunks.length,
            cacheHitCount: input.translatedChunks.filter((chunk) => chunk.cacheHit).length,
            translationSkipped: input.translationSkipped,
            detectedSourceLanguage: input.detectedSourceLanguage,
            autoLinkedReferenceCount: input.autoLinkedReferenceCount,
            discoveredReferenceAliasCount: input.discoveredReferenceAliasCount,
            metadataFieldCount: input.metadataFieldCount,
            metadataSources: input.metadataSources,
            metadataCacheHits: input.metadataCacheHits,
            readingAssetCount: input.readingAssets.length,
            readingAssetCacheHitCount: input.readingAssets.filter((asset) => asset.cacheHit).length
        }
    };
    await writeJsonFile(input.reportPath, report);
    return report;
}
function countHeadings(markdown) {
    return markdown.split(/\r?\n/).filter((line) => /^#{1,6}\s+/.test(line.trim())).length;
}
function extractImageRefs(markdown) {
    // 只检查本地图片，远程图片和 data URI 不属于当前导出目录的完整性范围。
    return Array.from(markdown.matchAll(/!\[[^\]]*]\(([^)]+)\)/g))
        .map((match) => match[1])
        .filter((path) => Boolean(path))
        .filter((path) => !path.startsWith('http://') && !path.startsWith('https://') && !path.startsWith('data:'));
}
async function findMissingImages(notePath, refs) {
    const noteDir = dirname(notePath);
    const missing = [];
    for (const ref of refs) {
        const imagePath = join(noteDir, ref);
        if (!(await pathExists(imagePath))) {
            missing.push(imagePath);
        }
    }
    return missing;
}
function validateFrontmatter(markdown, label, warnings) {
    const match = /^---\n([\s\S]*?)\n---/.exec(markdown);
    if (!match?.[1]) {
        warnings.push(`Missing ${label} frontmatter`);
        return;
    }
    try {
        YAML.parse(match[1]);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Invalid ${label} frontmatter: ${message}`);
    }
}
