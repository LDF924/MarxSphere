import YAML from 'yaml';
export function createFrontmatter(metadata, body) {
    return `---\n${YAML.stringify(metadata)}---\n\n${body.trim()}\n`;
}
