export function createCitationFormats(metadata) {
    const title = metadata.title.trim();
    if (!title) {
        return {};
    }
    return pruneEmptyValues({
        citationPlain: formatPlainCitation(metadata),
        citationApa: formatApaCitation(metadata),
        citationIeee: formatIeeeCitation(metadata),
        citationBibtex: formatBibtex(metadata)
    });
}
function formatPlainCitation(metadata) {
    return joinParts([
        joinAuthors(metadata.authors, 6),
        metadata.year ? `(${metadata.year})` : undefined,
        metadata.title,
        metadata.journal ?? metadata.venue,
        formatVolumeIssue(metadata.volume, metadata.issue),
        metadata.pages ? `pp. ${metadata.pages}` : undefined,
        formatIdentifier(metadata)
    ]) ?? metadata.title;
}
function formatApaCitation(metadata) {
    return joinParts([
        formatApaAuthors(metadata.authors),
        metadata.year ? `(${metadata.year}).` : undefined,
        `${metadata.title}.`,
        metadata.journal ?? metadata.venue,
        formatApaVolumeIssue(metadata.volume, metadata.issue),
        metadata.pages,
        metadata.doi ? `https://doi.org/${metadata.doi}` : metadata.url
    ]) ?? `${metadata.title}.`;
}
function formatIeeeCitation(metadata) {
    return joinParts([
        formatIeeeAuthors(metadata.authors),
        `"${metadata.title},"`,
        metadata.journal ?? metadata.venue,
        metadata.volume ? `vol. ${metadata.volume}` : undefined,
        metadata.issue ? `no. ${metadata.issue}` : undefined,
        metadata.pages ? `pp. ${metadata.pages}` : undefined,
        metadata.year?.toString(),
        formatIdentifier(metadata)
    ]) ?? metadata.title;
}
function formatBibtex(metadata) {
    const fields = [
        ['title', wrapBibtexValue(metadata.title)],
        ['author', wrapBibtexValue(metadata.authors.join(' and '))],
        ['year', metadata.year?.toString()],
        ['journal', wrapBibtexValue(metadata.journal ?? metadata.venue)],
        ['publisher', wrapBibtexValue(metadata.publisher)],
        ['volume', wrapBibtexValue(metadata.volume)],
        ['number', wrapBibtexValue(metadata.issue)],
        ['pages', wrapBibtexValue(metadata.pages)],
        ['doi', wrapBibtexValue(metadata.doi)],
        ['url', wrapBibtexValue(metadata.url)]
    ].filter(([, value]) => value);
    if (fields.length === 0) {
        return undefined;
    }
    return [
        `@article{${createBibtexKey(metadata)},`,
        ...fields.map(([name, value]) => `  ${name} = ${value},`),
        '}'
    ].join('\n');
}
function formatIdentifier(metadata) {
    if (metadata.doi) {
        return `doi:${metadata.doi}`;
    }
    return metadata.url;
}
function formatVolumeIssue(volume, issue) {
    if (volume && issue) {
        return `${volume}(${issue})`;
    }
    return volume ?? issue;
}
function formatApaVolumeIssue(volume, issue) {
    if (volume && issue) {
        return `${volume}(${issue}),`;
    }
    if (volume) {
        return `${volume},`;
    }
    return issue ? `(${issue}),` : undefined;
}
function formatApaAuthors(authors) {
    const normalized = authors.map(normalizeAuthor).filter(Boolean);
    if (normalized.length === 0) {
        return undefined;
    }
    const formatted = normalized.map((author) => {
        const parts = author.split(/\s+/).filter(Boolean);
        if (parts.length === 1) {
            return parts[0];
        }
        const family = parts[parts.length - 1];
        const initials = parts
            .slice(0, -1)
            .map((part) => `${part[0]?.toUpperCase()}.`)
            .join(' ');
        return `${family}, ${initials}`;
    });
    if (formatted.length === 1) {
        return formatted[0];
    }
    return `${formatted.slice(0, -1).join(', ')}, & ${formatted[formatted.length - 1]}`;
}
function formatIeeeAuthors(authors) {
    const normalized = authors.map(normalizeAuthor).filter(Boolean);
    if (normalized.length === 0) {
        return undefined;
    }
    const formatted = normalized.map((author) => {
        const parts = author.split(/\s+/).filter(Boolean);
        if (parts.length === 1) {
            return parts[0];
        }
        const family = parts[parts.length - 1];
        const initials = parts
            .slice(0, -1)
            .map((part) => `${part[0]?.toUpperCase()}.`)
            .join(' ');
        return `${initials} ${family}`.trim();
    });
    if (formatted.length <= 6) {
        return formatted.join(', ');
    }
    return `${formatted.slice(0, 6).join(', ')}, et al.`;
}
function joinAuthors(authors, maxAuthors) {
    const normalized = authors.map(normalizeAuthor).filter(Boolean);
    if (normalized.length === 0) {
        return undefined;
    }
    if (normalized.length <= maxAuthors) {
        return normalized.join(', ');
    }
    return `${normalized.slice(0, maxAuthors).join(', ')} et al.`;
}
function createBibtexKey(metadata) {
    const firstAuthor = normalizeAuthor(metadata.authors[0] ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .pop()
        ?.toLowerCase()
        .replace(/[^a-z0-9]+/g, '') ?? 'paper';
    const year = metadata.year?.toString() ?? 'nd';
    const titleToken = metadata.title
        .toLowerCase()
        .replace(/[^a-z0-9\s]+/g, ' ')
        .split(/\s+/)
        .find((token) => token.length >= 4) ?? 'work';
    return `${firstAuthor}${year}${titleToken}`;
}
function wrapBibtexValue(value) {
    const trimmed = value?.trim();
    return trimmed ? `{${trimmed.replace(/[{}]/g, '')}}` : undefined;
}
function joinParts(parts) {
    const filtered = parts.map((part) => part?.trim()).filter(Boolean);
    return filtered.length > 0 ? filtered.join(' ').replace(/\s+/g, ' ').trim() : undefined;
}
function normalizeAuthor(author) {
    return author.trim().replace(/\s+/g, ' ');
}
function pruneEmptyValues(values) {
    return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}
