import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import YAML from 'yaml';
export async function discoverReferenceAliases(input) {
    if (!input.config.enabled) {
        return {
            discoveredCount: 0,
            aliases: []
        };
    }
    const references = extractReferenceTitles(input.markdown);
    if (references.length === 0) {
        return {
            discoveredCount: 0,
            aliases: []
        };
    }
    const candidates = await collectCandidateNotes({
        vaultPath: input.vaultPath,
        config: input.config,
        excludeTargets: input.excludeTargets
    });
    const discovered = [];
    for (const reference of references) {
        const match = findBestCandidate(reference, candidates);
        if (!match || match.score < 0.55 || candidateAlreadyHasAlias(match.candidate, reference.title)) {
            continue;
        }
        await appendAliasToNote(match.candidate.path, reference.title);
        discovered.push({
            alias: reference.title,
            target: match.candidate.target,
            score: match.score
        });
    }
    return {
        discoveredCount: discovered.length,
        aliases: discovered
    };
}
function extractReferenceTitles(markdown) {
    const lines = markdown
        .replace(/^---\n[\s\S]*?\n---\n?/, '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    const references = [];
    for (const line of lines) {
        const match = /^\d+[.)]?\s+(.+?)[：:]\s+(.+)$/.exec(line);
        if (!match?.[2]) {
            continue;
        }
        const year = extractYear(line);
        const title = normalizeReferenceTitle(extractTitleSegment(match[2]));
        if (title.length >= 6 && !/^(doi|http|www)\b/i.test(title)) {
            references.push({
                title,
                year
            });
        }
    }
    return dedupeReferences(references);
}
function extractTitleSegment(value) {
    const separators = [
        '. ',
        '。 ',
        '. 西',
        '. J.',
        '. In:',
        '. 收录于',
        '. IEEE',
        '. SPE',
        '. Southwest',
        '. 油',
        '. 西南'
    ];
    let end = value.length;
    for (const separator of separators) {
        const index = value.indexOf(separator);
        if (index > 0) {
            end = Math.min(end, index);
        }
    }
    return value.slice(0, end);
}
function normalizeReferenceTitle(title) {
    return title
        .replace(/\[\[[^\]|]+\|([^\]]+)]]/g, '$1')
        .replace(/\[\[([^\]]+)]]/g, '$1')
        .replace(/\s+/g, ' ')
        .replace(/[.。；;，,：:]+$/g, '')
        .trim();
}
function extractYear(value) {
    const year = /\((19\d{2}|20\d{2})\)/.exec(value)?.[1] ?? /\b(19\d{2}|20\d{2})\b/.exec(value)?.[1];
    return year ? Number(year) : undefined;
}
function dedupeReferences(references) {
    const seen = new Set();
    const deduped = [];
    for (const reference of references) {
        const key = `${reference.title.toLocaleLowerCase()}-${reference.year ?? ''}`;
        if (!seen.has(key)) {
            seen.add(key);
            deduped.push(reference);
        }
    }
    return deduped;
}
async function collectCandidateNotes(input) {
    const scanRoots = input.config.scanDirs.length > 0
        ? input.config.scanDirs.map((dir) => join(input.vaultPath, dir))
        : [input.vaultPath];
    const excludedTargets = new Set(input.excludeTargets.map(normalizeObsidianTarget).map(canonicalizeGeneratedNoteTarget));
    const files = (await Promise.all(scanRoots.map((root) => listMarkdownFiles(root, input.config.excludeDirs)))).flat();
    const byTarget = new Map();
    for (const file of files) {
        if (isGeneratedAuxiliaryFile(file)) {
            continue;
        }
        const target = canonicalizeGeneratedNoteTarget(normalizeObsidianTarget(relative(input.vaultPath, file).replace(/\.md$/i, '')));
        if (excludedTargets.has(target)) {
            continue;
        }
        const markdown = await readFile(file, 'utf8');
        const parts = parseFrontmatter(markdown);
        const titles = extractTitles(parts.data, markdown, basename(file, '.md'));
        if (titles.length === 0) {
            continue;
        }
        const existing = byTarget.get(target);
        const note = {
            path: preferAliasWritePath(existing?.path, file),
            target,
            titles: Array.from(new Set([...(existing?.titles ?? []), ...titles])),
            aliases: Array.from(new Set([...(existing?.aliases ?? []), ...extractAliases(parts.data)])),
            year: existing?.year ?? extractFrontmatterYear(parts.data)
        };
        byTarget.set(target, note);
    }
    return Array.from(byTarget.values());
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
function parseFrontmatter(markdown) {
    const match = /^---\n([\s\S]*?)\n---\n?/.exec(markdown);
    if (!match?.[1]) {
        return {
            data: {},
            body: markdown
        };
    }
    try {
        const parsed = YAML.parse(match[1]);
        return {
            data: typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
                ? parsed
                : {},
            body: markdown.slice(match[0].length)
        };
    }
    catch {
        return {
            data: {},
            body: markdown.slice(match[0].length)
        };
    }
}
function extractTitles(frontmatter, markdown, fileStem) {
    const firstHeading = /^#{1,6}\s+(.+)$/m.exec(markdown)?.[1]?.trim();
    return [
        asString(frontmatter.title),
        asString(frontmatter.paperTitle),
        asString(frontmatter.translatedTitle),
        firstHeading,
        fileStem,
        ...extractAliases(frontmatter)
    ].filter((value) => Boolean(value));
}
function extractAliases(frontmatter) {
    const value = frontmatter.aliases;
    if (Array.isArray(value)) {
        return value.filter((item) => typeof item === 'string');
    }
    return typeof value === 'string' ? [value] : [];
}
function extractFrontmatterYear(frontmatter) {
    return typeof frontmatter.year === 'number' ? frontmatter.year : undefined;
}
function asString(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
function preferAliasWritePath(current, next) {
    if (!current) {
        return next;
    }
    if (basename(current).endsWith('.index.md')) {
        return current;
    }
    return basename(next).endsWith('.index.md') ? next : current;
}
function findBestCandidate(reference, candidates) {
    let best;
    for (const candidate of candidates) {
        if (reference.year && candidate.year && reference.year !== candidate.year) {
            continue;
        }
        const score = Math.max(...candidate.titles.map((title) => titleSimilarity(reference.title, title)));
        if (!best || score > best.score) {
            best = {
                candidate,
                score
            };
        }
    }
    return best;
}
function titleSimilarity(left, right) {
    const leftTokens = createTitleTokens(left);
    const rightTokens = createTitleTokens(right);
    if (leftTokens.size === 0 || rightTokens.size === 0) {
        return 0;
    }
    const intersection = Array.from(leftTokens).filter((token) => rightTokens.has(token)).length;
    const union = new Set([...leftTokens, ...rightTokens]).size;
    return intersection / union;
}
function createTitleTokens(title) {
    const normalized = title
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '');
    const chars = Array.from(normalized);
    if (chars.length <= 2) {
        return new Set(chars);
    }
    return new Set(chars.slice(0, -1).map((char, index) => `${char}${chars[index + 1] ?? ''}`));
}
function candidateAlreadyHasAlias(candidate, alias) {
    const normalizedAlias = alias.toLocaleLowerCase();
    return [...candidate.titles, ...candidate.aliases].some((value) => value.toLocaleLowerCase() === normalizedAlias);
}
async function appendAliasToNote(path, alias) {
    const markdown = await readFile(path, 'utf8');
    const parts = parseFrontmatter(markdown);
    const aliases = Array.from(new Set([...extractAliases(parts.data), alias]));
    parts.data.aliases = aliases;
    await writeFile(path, `---\n${YAML.stringify(parts.data).trim()}\n---\n\n${parts.body.trimStart()}`, 'utf8');
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
