export function toSlug(value) {
    return value
        .normalize('NFKC')
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .trim()
        .replace(/[\s_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
}
