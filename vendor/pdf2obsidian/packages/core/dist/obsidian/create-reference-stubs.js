import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import YAML from 'yaml';
import { pathExists, ensureDirectory, toSlug } from '../index.js';
/**
 * 为结构化参考文献创建桩笔记（stub note）。
 * 桩笔记包含基本元数据 frontmatter 和被引用论文的反向链接。
 * 如果 vault 中已有匹配标题的笔记则跳过。
 */
export async function createReferenceStubs(input) {
    if (input.references.length === 0) {
        return { createdCount: 0, skippedCount: 0, createdPaths: [] };
    }
    const existingTitles = await collectExistingNoteTitles({
        vaultPath: input.vaultPath,
        excludeTargets: input.excludeTargets
    });
    const createdPaths = [];
    let skippedCount = 0;
    for (const ref of input.references) {
        const normalizedTitle = ref.title.toLocaleLowerCase();
        if (existingTitles.has(normalizedTitle)) {
            skippedCount += 1;
            continue;
        }
        const stub = buildStubNote(ref, input.citingPaperSlug, input.citingPaperTitle);
        const slug = toSlug(ref.title) || `ref-${ref.doi?.replace(/[^a-zA-Z0-9]/g, '_') ?? 'unknown'}`;
        const filePath = join(input.vaultPath, input.documentDir, `${slug}.md`);
        // 避免覆盖已有文件
        if (await pathExists(filePath)) {
            skippedCount += 1;
            continue;
        }
        await ensureDirectory(join(input.vaultPath, input.documentDir));
        await writeFile(filePath, stub, 'utf8');
        createdPaths.push(filePath);
        existingTitles.add(normalizedTitle);
    }
    return {
        createdCount: createdPaths.length,
        skippedCount,
        createdPaths
    };
}
// ─── 内部工具 ───────────────────────────────────────────────
function buildStubNote(ref, citingSlug, citingTitle) {
    const frontmatter = {
        title: ref.title,
        type: 'reference-stub',
        ...(ref.authors.length > 0 ? { authors: ref.authors } : {}),
        ...(ref.year ? { year: ref.year } : {}),
        ...(ref.doi ? { doi: ref.doi } : {}),
        ...(ref.arxivId ? { arxivId: ref.arxivId } : {}),
        ...(ref.venue ? { journal: ref.venue } : {}),
        citedBy: [`[[${citingSlug}.index|${citingTitle}]]`],
        createdAt: new Date().toISOString()
    };
    const body = [
        `# ${ref.title}`,
        '',
        `> 此笔记由 PDF2Obsidian 自动生成，作为「[[${citingSlug}.index|${citingTitle}]]」的参考文献桩。`,
        '',
        '## 引用信息',
        '',
        ...(ref.authors.length > 0 ? [`- 作者：${ref.authors.join(', ')}`] : []),
        ...(ref.year ? [`- 年份：${ref.year}`] : []),
        ...(ref.venue ? [`- 期刊/会议：${ref.venue}`] : []),
        ...(ref.doi ? [`- DOI：${ref.doi}`] : []),
        ...(ref.arxivId ? [`- arXiv：${ref.arxivId}`] : []),
        '',
        '## 被引用',
        '',
        `- [[${citingSlug}.index|${citingTitle}]]`
    ].join('\n');
    return `---\n${YAML.stringify(frontmatter).trim()}\n---\n\n${body}\n`;
}
async function collectExistingNoteTitles(input) {
    const excluded = new Set(input.excludeTargets.map(normalizeTarget));
    const files = await listMarkdownFiles(input.vaultPath, ['.obsidian', '.trash']);
    const titles = new Set();
    for (const file of files) {
        const target = normalizeTarget(relative(input.vaultPath, file).replace(/\.md$/i, ''));
        if (excluded.has(target))
            continue;
        const markdown = await readFile(file, 'utf8');
        const fmMatch = /^---\n([\s\S]*?)\n---/.exec(markdown);
        if (fmMatch?.[1]) {
            try {
                const data = YAML.parse(fmMatch[1]);
                for (const key of ['title', 'paperTitle', 'translatedTitle']) {
                    const value = data[key];
                    if (typeof value === 'string' && value.trim()) {
                        titles.add(value.trim().toLocaleLowerCase());
                    }
                }
            }
            catch {
                // YAML 解析失败则跳过
            }
        }
        // 从第一个 heading 提取标题
        const heading = /^#{1,6}\s+(.+)$/m.exec(markdown);
        if (heading?.[1]) {
            titles.add(heading[1].trim().toLocaleLowerCase());
        }
    }
    return titles;
}
async function listMarkdownFiles(root, excludeDirs) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const files = [];
    const excluded = new Set(excludeDirs);
    for (const entry of entries) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) {
            if (!excluded.has(entry.name)) {
                files.push(...(await listMarkdownFiles(path, excludeDirs)));
            }
            continue;
        }
        if (entry.isFile() && entry.name.endsWith('.md')) {
            files.push(path);
        }
    }
    return files;
}
function normalizeTarget(target) {
    return target.split(sep).join('/');
}
