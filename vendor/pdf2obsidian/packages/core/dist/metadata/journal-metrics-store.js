import { dirname } from 'node:path';
import { ensureDirectory } from '../storage/file-system.js';
let initializedDbPath;
let db;
let databaseSyncConstructor;
let sqliteUnavailableWarned = false;
export async function getStoredJournalMetrics(config, publicationName) {
    const database = await getJournalMetricsDatabase(config);
    if (!database) {
        return undefined;
    }
    const row = database
        .prepare(`
      SELECT
        publication_name,
        lookup_status,
        impact_factor,
        five_year_impact_factor,
        jci,
        jcr_quartile,
        cas_quartile,
        cite_score,
        sjr,
        easy_scholar_query_matched,
        easy_scholar_ranks_json
      FROM journal_metrics
      WHERE publication_key = ?
    `)
        .get(normalizePublicationKey(publicationName));
    if (!row) {
        return undefined;
    }
    return {
        metadata: row.lookup_status === 'found' ? rowToMetadata(row) : undefined,
        publicationName: row.publication_name,
        status: row.lookup_status
    };
}
export async function upsertJournalMetrics(config, publicationName, metadata) {
    const database = await getJournalMetricsDatabase(config);
    if (!database) {
        return;
    }
    const now = new Date().toISOString();
    const normalizedKey = normalizePublicationKey(publicationName);
    const ranksJson = metadata?.easyScholarRanks ? JSON.stringify(metadata.easyScholarRanks) : null;
    database.prepare(`
    INSERT INTO journal_metrics (
      publication_key,
      publication_name,
      lookup_status,
      impact_factor,
      five_year_impact_factor,
      jci,
      jcr_quartile,
      cas_quartile,
      cite_score,
      sjr,
      easy_scholar_query_matched,
      easy_scholar_ranks_json,
      source,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(publication_key) DO UPDATE SET
      publication_name = excluded.publication_name,
      lookup_status = excluded.lookup_status,
      impact_factor = excluded.impact_factor,
      five_year_impact_factor = excluded.five_year_impact_factor,
      jci = excluded.jci,
      jcr_quartile = excluded.jcr_quartile,
      cas_quartile = excluded.cas_quartile,
      cite_score = excluded.cite_score,
      sjr = excluded.sjr,
      easy_scholar_query_matched = excluded.easy_scholar_query_matched,
      easy_scholar_ranks_json = excluded.easy_scholar_ranks_json,
      source = excluded.source,
      updated_at = excluded.updated_at
  `).run(normalizedKey, publicationName.trim(), metadata ? 'found' : 'missing', metadata?.impactFactor ?? null, metadata?.fiveYearImpactFactor ?? null, metadata?.jci ?? null, metadata?.jcrQuartile ?? null, metadata?.casQuartile ?? null, metadata?.citeScore ?? null, metadata?.sjr ?? null, metadata?.easyScholarQueryMatched ?? null, ranksJson, 'easyScholar', now);
}
async function getJournalMetricsDatabase(config) {
    const dbPath = config.sqlite.path;
    if (!db || initializedDbPath !== dbPath) {
        const DatabaseSync = await getDatabaseSyncConstructor();
        if (!DatabaseSync) {
            return undefined;
        }
        await ensureDirectory(dirname(dbPath));
        db?.close();
        db = new DatabaseSync(dbPath);
        initializeSchema(db);
        initializedDbPath = dbPath;
    }
    return db;
}
async function getDatabaseSyncConstructor() {
    if (databaseSyncConstructor) {
        return databaseSyncConstructor;
    }
    try {
        const sqliteModule = await import('node:sqlite');
        databaseSyncConstructor = sqliteModule.DatabaseSync;
        return databaseSyncConstructor;
    }
    catch (error) {
        if (!sqliteUnavailableWarned) {
            sqliteUnavailableWarned = true;
            console.warn(`[Core] 当前 Node.js 运行环境不支持 node:sqlite，已跳过本地期刊指标缓存：${error instanceof Error ? error.message : String(error)}`);
        }
        return undefined;
    }
}
function initializeSchema(database) {
    database.exec(`
    CREATE TABLE IF NOT EXISTS journal_metrics (
      publication_key TEXT PRIMARY KEY,
      publication_name TEXT NOT NULL,
      lookup_status TEXT NOT NULL CHECK (lookup_status IN ('found', 'missing')),
      impact_factor REAL,
      five_year_impact_factor REAL,
      jci REAL,
      jcr_quartile TEXT,
      cas_quartile TEXT,
      cite_score REAL,
      sjr REAL,
      easy_scholar_query_matched TEXT,
      easy_scholar_ranks_json TEXT,
      source TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}
function rowToMetadata(row) {
    return pruneEmptyValues({
        impactFactor: row.impact_factor ?? undefined,
        fiveYearImpactFactor: row.five_year_impact_factor ?? undefined,
        jci: row.jci ?? undefined,
        jcrQuartile: row.jcr_quartile ?? undefined,
        casQuartile: row.cas_quartile ?? undefined,
        easyScholarQueryMatched: row.easy_scholar_query_matched ?? undefined,
        easyScholarRanks: parseRanks(row.easy_scholar_ranks_json),
        citeScore: row.cite_score ?? undefined,
        sjr: row.sjr ?? undefined
    });
}
function parseRanks(value) {
    if (!value) {
        return undefined;
    }
    return JSON.parse(value);
}
function normalizePublicationKey(value) {
    return value.trim().toLocaleLowerCase();
}
function pruneEmptyValues(values) {
    return Object.fromEntries(Object.entries(values).filter(([, value]) => {
        if (Array.isArray(value)) {
            return value.length > 0;
        }
        return value !== undefined && value !== null && value !== '';
    }));
}
