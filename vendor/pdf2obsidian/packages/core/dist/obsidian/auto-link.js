import { readdir, readFile } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import YAML from 'yaml';
export async function autoLinkMarkdown(input) {
    if (!input.config.enabled || input.config.maxLinksPerNote === 0) {
        return {
            markdown: input.markdown,
            links: []
        };
    }
    const candidates = await collectLinkCandidates({
        vaultPath: input.vaultPath,
        config: input.config,
        excludeTargets: input.excludeTargets
    });
    return linkCandidates({
        markdown: input.markdown,
        candidates,
        maxLinks: input.config.maxLinksPerNote
    });
}
async function collectLinkCandidates(input) {
    const scanRoots = input.config.scanDirs.length > 0
        ? input.config.scanDirs.map((dir) => join(input.vaultPath, dir))
        : [input.vaultPath];
    const excludedTargets = new Set(input.excludeTargets.map(normalizeObsidianTarget));
    const files = (await Promise.all(scanRoots.map((root) => listMarkdownFiles(root, input.config.excludeDirs)))).flat();
    const candidates = [];
    for (const file of files) {
        // summary/terms/qa 是当前论文的辅助材料，不参与别名库，避免自动链接到阅读材料自身。
        if (isGeneratedAuxiliaryFile(file)) {
            continue;
        }
        // 对生成的 original/zh 笔记统一指向 index，用户点击链接时进入该论文的总入口。
        const target = canonicalizeGeneratedNoteTarget(normalizeObsidianTarget(relative(input.vaultPath, file).replace(/\.md$/i, '')));
        if (excludedTargets.has(target)) {
            continue;
        }
        const markdown = await readFile(file, 'utf8');
        for (const alias of extractAliases(markdown, basename(file, '.md'))) {
            if (alias.length >= input.config.minAliasLength) {
                candidates.push({
                    alias,
                    target
                });
            }
        }
    }
    return dedupeCandidates(candidates).sort((a, b) => b.alias.length - a.alias.length);
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
function extractAliases(markdown, fileStem) {
    const frontmatter = parseFrontmatter(markdown);
    const title = typeof frontmatter.title === 'string' ? frontmatter.title : undefined;
    const paperTitle = typeof frontmatter.paperTitle === 'string' ? frontmatter.paperTitle : undefined;
    const translatedTitle = typeof frontmatter.translatedTitle === 'string' ? frontmatter.translatedTitle : undefined;
    const aliases = extractFrontmatterAliases(frontmatter.aliases);
    const firstHeading = /^#{1,6}\s+(.+)$/m.exec(markdown)?.[1]?.trim();
    return Array.from(new Set([
        title,
        paperTitle,
        translatedTitle,
        firstHeading,
        fileStem,
        ...aliases
    ].filter((value) => Boolean(value))));
}
function extractFrontmatterAliases(value) {
    if (Array.isArray(value)) {
        return value.filter((item) => typeof item === 'string');
    }
    return typeof value === 'string' ? [value] : [];
}
function parseFrontmatter(markdown) {
    const match = /^---\n([\s\S]*?)\n---/.exec(markdown);
    if (!match?.[1]) {
        return {};
    }
    try {
        const parsed = YAML.parse(match[1]);
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? parsed
            : {};
    }
    catch {
        return {};
    }
}
function dedupeCandidates(candidates) {
    const seen = new Set();
    const deduped = [];
    for (const candidate of candidates) {
        const key = `${candidate.alias.toLocaleLowerCase()} -> ${candidate.target}`;
        if (!seen.has(key)) {
            seen.add(key);
            deduped.push(candidate);
        }
    }
    return deduped;
}
function linkCandidates(input) {
    const linkedTexts = new Set();
    const links = [];
    const lines = input.markdown.split(/\r?\n/);
    let inFrontmatter = false;
    let inCodeFence = false;
    // 自动链接跳过 frontmatter、代码块和标题，避免破坏 YAML、示例代码与 Markdown 结构。
    const nextLines = lines.map((line, index) => {
        if (index === 0 && line.trim() === '---') {
            inFrontmatter = true;
            return line;
        }
        if (inFrontmatter) {
            if (line.trim() === '---') {
                inFrontmatter = false;
            }
            return line;
        }
        if (/^\s*```/.test(line)) {
            inCodeFence = !inCodeFence;
            return line;
        }
        if (inCodeFence || /^#{1,6}\s+/.test(line)) {
            return line;
        }
        let nextLine = line;
        for (const candidate of input.candidates) {
            if (links.length >= input.maxLinks) {
                break;
            }
            if (linkedTexts.has(candidate.alias.toLocaleLowerCase())) {
                continue;
            }
            const replaced = replaceFirstPlainText(nextLine, candidate);
            if (replaced !== nextLine) {
                nextLine = replaced;
                linkedTexts.add(candidate.alias.toLocaleLowerCase());
                links.push({
                    text: candidate.alias,
                    target: candidate.target
                });
            }
        }
        return nextLine;
    });
    return {
        markdown: nextLines.join('\n'),
        links
    };
}
function replaceFirstPlainText(line, candidate) {
    const protectedRanges = findProtectedRanges(line);
    const pattern = createAliasPattern(candidate.alias);
    const match = pattern.exec(line);
    if (!match || match.index === undefined) {
        return line;
    }
    const start = match.index;
    const end = start + match[0].length;
    if (protectedRanges.some((range) => start >= range.start && end <= range.end)) {
        return line;
    }
    return `${line.slice(0, start)}[[${candidate.target}|${match[0]}]]${line.slice(end)}`;
}
function findProtectedRanges(line) {
    // 已存在的 Markdown 链接、Obsidian 双链、图片和行内代码都不再二次包裹。
    const patterns = [
        /!\[[^\]]*]\([^)]+\)/g,
        /\[[^\]]+]\([^)]+\)/g,
        /\[\[[^\]]+]]/g,
        /`[^`]+`/g
    ];
    return patterns.flatMap((pattern) => Array.from(line.matchAll(pattern)).map((match) => ({
        start: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length
    })));
}
function createAliasPattern(alias) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hasWordBoundary = /^[\p{L}\p{N}_ -]+$/u.test(alias);
    return hasWordBoundary
        ? new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'u')
        : new RegExp(escaped, 'u');
}
function normalizeObsidianTarget(target) {
    return target.split(sep).join('/');
}
function isGeneratedAuxiliaryFile(path) {
    const name = basename(path).toLocaleLowerCase();
    return name === 'summary.md' || name === 'terms.md' || name === 'qa.md' ||
        name === '摘要.md' || name === '术语表.md' || name === '问答.md';
}
function canonicalizeGeneratedNoteTarget(target) {
    return target.replace(/\.(?:original|zh)$/i, '.index');
}
