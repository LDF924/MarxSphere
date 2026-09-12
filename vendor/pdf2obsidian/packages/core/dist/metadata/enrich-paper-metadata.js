import { join } from 'node:path';
import { ensureDirectory, pathExists, readTextFile, writeJsonFile } from '../storage/file-system.js';
import { sha256Text } from '../utils/hash.js';
import { getStoredJournalMetrics, upsertJournalMetrics } from './journal-metrics-store.js';
export async function enrichPaperMetadata(input) {
    const warnings = [];
    const sources = [];
    const cacheHits = [];
    let metadata = input.metadata;
    if (input.config.online.enabled) {
        // Crossref/OpenAlex 逐个补全字段；单个来源失败只降级为 warning，不能阻断论文导入。
        for (const provider of input.config.online.providers) {
            try {
                const result = await fetchProviderMetadata(provider, metadata, input.config.online);
                if (result.cacheHit) {
                    cacheHits.push(provider);
                }
                if (result.metadata) {
                    metadata = mergeOnlineMetadata(metadata, result.metadata);
                    sources.push(provider);
                }
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                warnings.push(`${provider}: ${message}`);
            }
        }
    }
    const metrics = await readJournalMetrics(metadata, input.config.journalMetrics);
    if (metrics) {
        // 本地期刊指标库优先，避免 EasyScholar 额度消耗，也让离线场景可用。
        metadata = mergeMetadata(metadata, metrics);
        sources.push('journalMetricsDb');
    }
    try {
        const easyScholarMetrics = await fetchEasyScholarMetrics(metadata, input.config.journalMetrics);
        if (easyScholarMetrics.metadata) {
            metadata = mergeMetadata(metadata, easyScholarMetrics.metadata);
            sources.push('easyScholar');
            if (easyScholarMetrics.cacheHit) {
                cacheHits.push('easyScholar');
            }
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`easyScholar: ${message}`);
    }
    return {
        metadata,
        sources,
        warnings,
        cacheHits
    };
}
export function mergeMetadata(base, next) {
    // 本地解析出的 title/authors/keywords 优先保留，在线来源主要用于补 DOI、年份、期刊和指标。
    return {
        ...base,
        ...pruneEmptyValues(next),
        title: next.title || base.title || '',
        aliases: base.aliases ?? next.aliases,
        authors: base.authors.length > 0 ? base.authors : mergeStringArrays(base.authors, next.authors),
        keywords: base.keywords.length > 0 ? base.keywords : mergeStringArrays(base.keywords, next.keywords)
    };
}
function mergeOnlineMetadata(base, next) {
    // 在线元数据只填补空缺字段；引用量和指标类字段使用更新来源覆盖。
    return {
        ...base,
        year: base.year ?? next.year,
        venue: base.venue ?? next.venue,
        journal: base.journal ?? next.journal,
        publisher: base.publisher ?? next.publisher,
        volume: base.volume ?? next.volume,
        issue: base.issue ?? next.issue,
        pages: base.pages ?? next.pages,
        doi: base.doi ?? next.doi,
        arxivId: base.arxivId ?? next.arxivId,
        abstract: base.abstract ?? next.abstract,
        url: base.url ?? next.url,
        openAccessUrl: base.openAccessUrl ?? next.openAccessUrl,
        citationCount: next.citationCount ?? base.citationCount,
        influentialCitationCount: next.influentialCitationCount ?? base.influentialCitationCount,
        openAlexId: next.openAlexId ?? base.openAlexId,
        semanticScholarId: next.semanticScholarId ?? base.semanticScholarId,
        fieldsOfStudy: base.fieldsOfStudy ?? next.fieldsOfStudy,
        impactFactor: next.impactFactor ?? base.impactFactor,
        fiveYearImpactFactor: next.fiveYearImpactFactor ?? base.fiveYearImpactFactor,
        jci: next.jci ?? base.jci,
        jcrQuartile: next.jcrQuartile ?? base.jcrQuartile,
        casQuartile: next.casQuartile ?? base.casQuartile,
        easyScholarQueryTried: next.easyScholarQueryTried ?? base.easyScholarQueryTried,
        easyScholarQueryMatched: next.easyScholarQueryMatched ?? base.easyScholarQueryMatched,
        easyScholarRanks: next.easyScholarRanks ?? base.easyScholarRanks,
        citeScore: next.citeScore ?? base.citeScore,
        sjr: next.sjr ?? base.sjr,
        aliases: base.aliases ?? next.aliases,
        authors: base.authors.length > 0 ? base.authors : mergeStringArrays(base.authors, next.authors),
        keywords: base.keywords.length > 0 ? base.keywords : mergeStringArrays(base.keywords, next.keywords)
    };
}
async function fetchProviderMetadata(provider, metadata, config) {
    const cacheKey = sha256Text(`${provider}:${metadata.doi ?? metadata.title}`);
    const cachePath = join(config.cacheDir, `${provider}-${cacheKey.slice(0, 24)}.json`);
    await ensureDirectory(config.cacheDir);
    if (await pathExists(cachePath)) {
        const cached = JSON.parse(await readTextFile(cachePath));
        return {
            metadata: cached ?? undefined,
            cacheHit: true
        };
    }
    const fetched = await fetchFreshProviderMetadata(provider, metadata, config);
    // 标题相似度太低时认为命中了错误论文，缓存 null 防止后续重复请求同一错误结果。
    const checked = isCompatibleMetadata(metadata, fetched) ? fetched : undefined;
    await writeJsonFile(cachePath, checked ?? null);
    return {
        metadata: checked,
        cacheHit: false
    };
}
async function fetchFreshProviderMetadata(provider, metadata, config) {
    if (provider === 'crossref') {
        return fetchCrossref(metadata, config);
    }
    if (provider === 'openalex') {
        return fetchOpenAlex(metadata, config);
    }
    return undefined;
}
async function fetchCrossref(metadata, config) {
    // DOI 查询精度最高；没有 DOI 时只按标题取第一条候选，并在外层做兼容性校验。
    const baseUrl = metadata.doi
        ? `https://api.crossref.org/works/${encodeURIComponent(metadata.doi)}`
        : `https://api.crossref.org/works?rows=1&query.title=${encodeURIComponent(metadata.title)}`;
    const url = withMailto(baseUrl, config.email);
    const data = await fetchJson(url, config.timeoutMs);
    const message = data.message;
    const work = isCrossrefSearchMessage(message) ? message.items?.[0] : message;
    if (!work || isCrossrefSearchMessage(work)) {
        return undefined;
    }
    const year = extractCrossrefYear(work);
    return pruneEmptyValues({
        title: work.title?.[0],
        authors: work.author?.map((author) => formatCrossrefAuthor(author)).filter((author) => Boolean(author)),
        year,
        journal: work['container-title']?.[0],
        publisher: work.publisher,
        volume: work.volume,
        issue: work.issue,
        pages: work.page,
        doi: work.DOI,
        url: work.URL,
        abstract: stripXml(work.abstract),
        keywords: work.subject
    });
}
async function fetchOpenAlex(metadata, config) {
    const filter = metadata.doi ? `filter=doi:${encodeURIComponent(metadata.doi)}` : `search=${encodeURIComponent(metadata.title)}`;
    const url = `https://api.openalex.org/works?${filter}&per-page=1${config.email ? `&mailto=${encodeURIComponent(config.email)}` : ''}`;
    const data = await fetchJson(url, config.timeoutMs);
    const work = data.results?.[0];
    if (!work) {
        return undefined;
    }
    return pruneEmptyValues({
        title: work.title,
        authors: work.authorships?.map((authorship) => authorship.author?.display_name).filter((author) => Boolean(author)),
        year: work.publication_year,
        journal: work.primary_location?.source?.display_name,
        publisher: work.primary_location?.source?.host_organization_name,
        doi: normalizeDoi(work.doi),
        url: work.primary_location?.landing_page_url,
        openAccessUrl: work.open_access?.oa_url,
        citationCount: work.cited_by_count,
        openAlexId: work.id,
        keywords: work.concepts?.map((concept) => concept.display_name).filter((concept) => Boolean(concept))
    });
}
async function fetchJson(url, timeoutMs, headers) {
    // 所有外部元数据请求统一走超时控制，避免单个网络调用拖住整条导入流水线。
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const init = { signal: controller.signal };
        if (headers) {
            init.headers = headers;
        }
        const response = await fetch(url, init);
        if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`);
        }
        return await response.json();
    }
    finally {
        clearTimeout(timeout);
    }
}
async function readJournalMetrics(metadata, config) {
    const publicationNames = createEasyScholarCandidates(metadata);
    // journal 与 venue 都可能承载期刊/会议名称，逐个查本地缓存并记录实际匹配项。
    for (const publicationName of publicationNames) {
        const stored = await getStoredJournalMetrics(config, publicationName);
        if (stored?.status === 'found' && stored.metadata) {
            return {
                ...stored.metadata,
                easyScholarQueryTried: publicationNames,
                easyScholarQueryMatched: stored.metadata.easyScholarQueryMatched ?? stored.publicationName
            };
        }
    }
    return undefined;
}
async function fetchEasyScholarMetrics(metadata, config) {
    if (!config.easyScholar.enabled) {
        return {
            metadata: undefined,
            cacheHit: false
        };
    }
    const secretKey = config.easyScholar.secretKey ?? (config.easyScholar.secretKeyEnv ? process.env[config.easyScholar.secretKeyEnv] : undefined);
    if (!secretKey) {
        throw new Error(`Missing ${config.easyScholar.secretKeyEnv ?? 'EasyScholar secretKey'} environment variable`);
    }
    // EasyScholar 只查询期刊/会议名；publisher 或论文标题会浪费额度且几乎没有有效命中。
    const publicationNames = createEasyScholarCandidates(metadata);
    let sawDatabaseHit = false;
    const missingNames = [];
    for (const publicationName of publicationNames) {
        const stored = await getStoredJournalMetrics(config, publicationName);
        if (stored) {
            sawDatabaseHit = true;
            if (stored.status === 'found' && stored.metadata) {
                return {
                    metadata: {
                        easyScholarQueryTried: publicationNames,
                        ...stored.metadata,
                        easyScholarQueryMatched: stored.metadata.easyScholarQueryMatched ?? stored.publicationName
                    },
                    cacheHit: true
                };
            }
            continue;
        }
        missingNames.push(publicationName);
    }
    for (const publicationName of missingNames) {
        const url = new URL(config.easyScholar.baseUrl);
        url.searchParams.set('secretKey', secretKey);
        url.searchParams.set('publicationName', publicationName);
        const data = await fetchJson(url.toString(), config.easyScholar.timeoutMs);
        if (data.code !== 200 || !data.data) {
            await upsertJournalMetrics(config, publicationName, undefined);
            continue;
        }
        const metrics = parseEasyScholarMetrics(data.data.officialRank?.all ?? {}, publicationName);
        await upsertJournalMetrics(config, publicationName, metrics);
        if (metrics) {
            return {
                metadata: {
                    easyScholarQueryTried: publicationNames,
                    ...metrics
                },
                cacheHit: sawDatabaseHit
            };
        }
    }
    return {
        metadata: {
            easyScholarQueryTried: publicationNames
        },
        cacheHit: sawDatabaseHit
    };
}
function createEasyScholarCandidates(metadata) {
    return Array.from(new Set([
        metadata.journal,
        metadata.venue
    ]
        .filter((value) => Boolean(value))
        .map((value) => value.trim())
        .filter((value) => value.length > 0)));
}
function parseEasyScholarMetrics(ranks, publicationName) {
    const metrics = pruneEmptyValues({
        impactFactor: parseNumber(ranks.sciif),
        fiveYearImpactFactor: parseNumber(ranks.sciif5),
        jci: parseNumber(ranks.jci),
        jcrQuartile: normalizeQuartile(ranks.sci ?? ranks.ssci),
        casQuartile: ranks.sciUp ?? ranks.sciBase,
        easyScholarQueryMatched: publicationName,
        easyScholarRanks: Object.keys(ranks).length > 0 ? ranks : undefined
    });
    return Object.keys(metrics).length > 0 ? metrics : undefined;
}
function isCrossrefSearchMessage(value) {
    return typeof value === 'object' && value !== null && 'items' in value;
}
function withMailto(url, email) {
    if (!email) {
        return url;
    }
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}mailto=${encodeURIComponent(email)}`;
}
function extractCrossrefYear(work) {
    return work.published?.['date-parts']?.[0]?.[0] ?? work.issued?.['date-parts']?.[0]?.[0];
}
function formatCrossrefAuthor(author) {
    if (author.name) {
        return author.name;
    }
    return [author.given, author.family].filter(Boolean).join(' ') || undefined;
}
function stripXml(value) {
    return value?.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}
function normalizeDoi(value) {
    return value?.replace(/^https?:\/\/doi\.org\//i, '');
}
function parseNumber(value) {
    if (!value) {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
function normalizeQuartile(value) {
    if (!value) {
        return undefined;
    }
    const upper = value.toLocaleUpperCase();
    return /^Q[1-4]$/.test(upper) ? upper : value;
}
function isCompatibleMetadata(base, next) {
    if (!next?.title || !base.title) {
        return true;
    }
    // 标题相似度阈值偏保守，宁可少补字段，也不要把另一篇论文的 DOI/作者写进笔记。
    return calculateTitleSimilarity(base.title, next.title) >= 0.45;
}
function calculateTitleSimilarity(left, right) {
    const leftWords = normalizeTitleWords(left);
    const rightWords = normalizeTitleWords(right);
    if (leftWords.size === 0 || rightWords.size === 0) {
        return 0;
    }
    const intersection = Array.from(leftWords).filter((word) => rightWords.has(word)).length;
    const union = new Set([...leftWords, ...rightWords]).size;
    return intersection / union;
}
function normalizeTitleWords(value) {
    return new Set(value
        .toLocaleLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter((word) => word.length > 2));
}
function mergeStringArrays(base, next) {
    return Array.from(new Set([...(base ?? []), ...(next ?? [])].filter((value) => value.length > 0)));
}
function pruneEmptyValues(values) {
    return Object.fromEntries(Object.entries(values).filter(([, value]) => {
        if (Array.isArray(value)) {
            return value.length > 0;
        }
        return value !== undefined && value !== null && value !== '';
    }));
}
