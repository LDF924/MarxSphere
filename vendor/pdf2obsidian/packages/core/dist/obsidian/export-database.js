import { join } from 'node:path';
import YAML from 'yaml';
import { ensureDirectory, writeTextFile } from '../storage/file-system.js';
export async function exportObsidianDatabase(config) {
    if (!config.obsidian.database.enabled) {
        return undefined;
    }
    const databasePath = join(config.vault.path, config.vault.documentDir, config.obsidian.database.fileName);
    await ensureDirectory(join(config.vault.path, config.vault.documentDir));
    await writeTextFile(databasePath, createBaseFile(config));
    return databasePath;
}
function createBaseFile(config) {
    const base = {
        filters: `type == "index" && file.inFolder("${config.vault.documentDir}")`,
        properties: {
            'file.name': { displayName: '名称' },
            translatedTitle: { displayName: '标题' },
            authors: { displayName: '作者' },
            year: { displayName: '年份' },
            journal: { displayName: '期刊/会议' },
            citationCount: { displayName: '引用' },
            impactFactor: { displayName: '影响因子' },
            jcrQuartile: { displayName: 'JCR' },
            casQuartile: { displayName: '中科院' },
            doi: { displayName: 'DOI' },
            citationApa: { displayName: '引用 APA' },
            citationBibtex: { displayName: '引用 BibTeX' }
        },
        views: [
            {
                type: 'table',
                name: '论文',
                order: [
                    'file.name',
                    'translatedTitle',
                    'year',
                    'journal',
                    'citationCount',
                    'impactFactor',
                    'jcrQuartile',
                    'casQuartile',
                    'doi'
                ],
                sort: [
                    { property: 'year', direction: 'DESC' },
                    { property: 'citationCount', direction: 'DESC' }
                ]
            },
            {
                type: 'table',
                name: '引用',
                order: [
                    'file.name',
                    'translatedTitle',
                    'authors',
                    'year',
                    'citationApa',
                    'citationBibtex',
                    'doi'
                ],
                sort: [
                    { property: 'year', direction: 'DESC' },
                    { property: 'file.name', direction: 'ASC' }
                ]
            }
        ]
    };
    return YAML.stringify(base);
}
