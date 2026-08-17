// literature-service.ts — MarxSphere 本地文献库服务
// 读取用户主目录课题文献库的论文元数据，提供筛选检索。
// 复刻 Sciverse 的 meta-catalog + meta-search 模式，但数据是本地文献。
//
// 数据源: ~/1.Obsidian Vault/课题文献库/学术期刊/{主题}/Markdown/{论文}/
//   每篇: {title}_信息.md (frontmatter) + {title}.index.md (元数据表) + {title}.original.md
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 脱敏: 个人盘符路径改为 os.homedir() 相对（LITERATURE_DIR env 可覆盖）
const ACADEMIC_JOURNAL_DIR = process.env.LITERATURE_DIR || path.join(os.homedir(), "1.Obsidian Vault", "课题文献库（CSSCI、北大核心、CSCD、AMI、WJCI）", "学术期刊");

export interface LiteratureRecord {
  id: string;              // 论文唯一 id（用 sourceHash 或文件名 hash）
  title: string;           // 标题
  paperTitle: string;      // paperTitle
  authors: string[];       // 作者
  topic: string;           // 主题（所属目录，如 资本下乡）
  year: string;            // 年份（从文件名或内容推断）
  path: string;            // 论文目录
  sourcePdf?: string;      // 源 PDF 名
  createdAt?: string;      // 创建时间
  hasSummary: boolean;     // 是否有摘要.md
  hasQa: boolean;          // 是否有问答.md
  hasTerms: boolean;       // 是否有术语表.md
}

export interface LiteratureFilter {
  topic?: string;
  author?: string;
  year?: string;
  keyword?: string;
  page?: number;
  pageSize?: number;
}

export interface LiteratureCatalog {
  topics: string[];
  authors: string[];
  years: string[];
  total: number;
}

export interface LiteratureDetail extends LiteratureRecord {
  summary?: string;
  qa?: string;
  terms?: string;
  originalExcerpt?: string;
  originalText?: string;
  indexMeta?: string;
  keywords?: string[];
  category?: string;
}

// 读取论文目录下的辅助文件内容（去除 frontmatter 后的正文）
function readAuxContent(paperDir: string, fileName: string): string | undefined {
  const fullPath = path.join(paperDir, fileName);
  if (!fs.existsSync(fullPath)) return undefined;
  const content = fs.readFileSync(fullPath, "utf-8");
  // 去掉 frontmatter (--- 之间)
  const fmEnd = content.indexOf("---", 3);
  if (content.startsWith("---") && fmEnd > 0) {
    return content.slice(fmEnd + 3).trim();
  }
  return content.trim();
}

function getLiteratureDetail(id: string): LiteratureDetail | null {
  const records = getRecords();
  const record = records.find((r) => r.id === id);
  if (!record) return null;

  // 遍历目录找实际文件（避免重名论文 title 拼接失败）
  const findFile = (paperDir: string, suffix: string): string | undefined => {
    try {
      const files = fs.readdirSync(paperDir).filter((f) => f.endsWith(suffix));
      return files.length > 0 ? files[0] : undefined;
    } catch {
      return undefined;
    }
  };

  // 从 index.md 提取关键词 + 完整元数据表
  let keywords: string[] | undefined;
  let category: string | undefined;
  let indexMeta: string | undefined;
  const indexFile = findFile(record.path, ".index.md");
  if (indexFile) {
    const indexContent = fs.readFileSync(path.join(record.path, indexFile), "utf-8");
    const fmEnd = indexContent.indexOf("---", 3);
    const body = fmEnd > 0 ? indexContent.slice(fmEnd + 3) : indexContent;
    // 完整元数据表（## 元数据 之后的部分）
    const metaIdx = body.indexOf("## 元数据");
    if (metaIdx >= 0) {
      indexMeta = body.slice(metaIdx).trim().slice(0, 2000);
    }
    // 关键词
    const kwMatch = body.match(/\|\s*关键词\s*\|\s*([^|]+)\|/);
    if (kwMatch) {
      keywords = kwMatch[1].split(/[、,，;；\s]+/).map((k) => k.trim()).filter(Boolean);
    }
    // 中图分类号
    const catMatch = body.match(/中图分类号[：:\s]*([A-Za-z0-9．.]+)/);
    if (catMatch) category = catMatch[1];
  }

  // original.md 完整原文
  let originalText: string | undefined;
  let originalExcerpt: string | undefined;
  const originalFile = findFile(record.path, ".original.md");
  if (originalFile) {
    const origContent = fs.readFileSync(path.join(record.path, originalFile), "utf-8");
    const fmEnd = origContent.indexOf("---", 3);
    const body = fmEnd > 0 ? origContent.slice(fmEnd + 3) : origContent;
    originalText = body.trim();
    originalExcerpt = body.trim().slice(0, 3000);
  }

  return {
    ...record,
    summary: readAuxContent(record.path, "摘要.md"),
    qa: readAuxContent(record.path, "问答.md"),
    terms: readAuxContent(record.path, "术语表.md"),
    originalExcerpt,
    originalText,
    indexMeta,
    keywords,
    category
  };
}

// 简单 hash 生成稳定 id
function hashString(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36).slice(0, 12);
}

function extractFrontmatterField(content: string, field: string): string | undefined {
  const match = content.match(new RegExp(`^${field}:\s*(.+)$`, "m"));
  if (!match) return undefined;
  return match[1].trim().replace(/^["']|["']$/g, "").replace(/\r/g, "");
}

function extractAuthorsFromInfo(infoContent: string): string[] {
  // frontmatter authors 可能是数组
  const arrMatch = infoContent.match(/^authors:\s*$/m);
  if (arrMatch) {
    const rest = infoContent.slice(infoContent.indexOf("authors:") + 8);
    const items = rest.split("\n").filter((line) => line.trim().startsWith("- ")).map((line) => line.trim().slice(2).trim());
    if (items.length > 0) return items;
  }
  const single = extractFrontmatterField(infoContent, "authors");
  if (single && !single.includes("[") && single !== "无可否认") {
    return [single];
  }
  return [];
}

function extractYearFromFileName(fileName: string): string {
  // 文件名形如: title_作者（年份）
  const match = fileName.match(/[（(](19\d\d|20\d\d)[）)]/);
  return match ? match[1] : "";
}

function extractYearFromTopic(topic: string): string {
  // 目录名形如 "资本下乡（2012—2026年6月）" → 取起始年份
  const match = topic.match(/[（(](\d{4})[—\-～至](\d{4})/);
  if (match) return match[1];
  const single = topic.match(/[（(](\d{4})年/);
  return single ? single[1] : "";
}

function scanTopic(topicDir: string, topicName: string): LiteratureRecord[] {
  const markdownDir = path.join(topicDir, "Markdown");
  if (!fs.existsSync(markdownDir)) return [];

  const records: LiteratureRecord[] = [];
  const entries = fs.readdirSync(markdownDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;

    const paperDir = path.join(markdownDir, entry.name);
    const infoFiles = fs.readdirSync(paperDir).filter((f) => f.endsWith("_信息.md"));
    if (infoFiles.length === 0) continue;

    const infoPath = path.join(paperDir, infoFiles[0]);
    const infoContent = fs.readFileSync(infoPath, "utf-8");
    const title = extractFrontmatterField(infoContent, "title")?.replace(/\s*-\s*信息$/, "") || entry.name;
    const paperTitle = extractFrontmatterField(infoContent, "paperTitle") || title;
    const sourceHash = extractFrontmatterField(infoContent, "sourceHash");
    const createdAt = extractFrontmatterField(infoContent, "createdAt");

    // 作者：优先 info frontmatter，其次文件名下划线后的部分
    let authors = extractAuthorsFromInfo(infoContent);
    if (authors.length === 0) {
      const parts = entry.name.split("_");
      if (parts.length > 1) {
        authors = [parts[parts.length - 1]];
      }
    }

    // 文件名 id
    const id = sourceHash ? hashString(sourceHash) : hashString(paperDir);

    // 年份：优先文件名，其次主题起始年份兜底
    let year = extractYearFromFileName(entry.name);
    if (!year) year = extractYearFromTopic(topicName);

    // 从 original.md 提取 sourcePdf（PDF 源文件名）
    // 用目录里实际存在的 .original.md 文件（避免重名时目录名≠文件名）
    let sourcePdf: string | undefined;
    const originalFiles = fs.readdirSync(paperDir).filter((f) => f.endsWith(".original.md"));
    if (originalFiles.length > 0) {
      const originalContent = fs.readFileSync(path.join(paperDir, originalFiles[0]), "utf-8");
      sourcePdf = extractFrontmatterField(originalContent, "sourcePdf");
    }

    records.push({
      id,
      title,
      paperTitle,
      authors,
      topic: topicName,
      year,
      path: paperDir,
      sourcePdf,
      createdAt,
      hasSummary: fs.existsSync(path.join(paperDir, "摘要.md")),
      hasQa: fs.existsSync(path.join(paperDir, "问答.md")),
      hasTerms: fs.existsSync(path.join(paperDir, "术语表.md"))
    });
  }
  return records;
}

function scanAll(): LiteratureRecord[] {
  if (!fs.existsSync(ACADEMIC_JOURNAL_DIR)) {
    console.warn(`[literature] 目录不存在: ${ACADEMIC_JOURNAL_DIR}`);
    return [];
  }
  const topics = fs.readdirSync(ACADEMIC_JOURNAL_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  let all: LiteratureRecord[] = [];
  for (const topic of topics) {
    const records = scanTopic(path.join(ACADEMIC_JOURNAL_DIR, topic), topic);
    all = all.concat(records);
  }
  return all;
}

// 缓存：首次扫描后缓存，文件变化时重建
let cache: LiteratureRecord[] | null = null;
let cacheTimestamp = 0;

function getRecords(refresh = false): LiteratureRecord[] {
  if (refresh || !cache) {
    cache = scanAll();
    cacheTimestamp = Date.now();
  }
  return cache;
}

function listLiterature(filter: LiteratureFilter = {}): {
  total: number;
  items: LiteratureRecord[];
  page: number;
  pageSize: number;
} {
  const records = getRecords();
  let filtered = records;

  if (filter.topic) filtered = filtered.filter((r) => r.topic.includes(filter.topic!));
  if (filter.author) filtered = filtered.filter((r) => r.authors.some((a) => a.includes(filter.author!)));
  if (filter.year) filtered = filtered.filter((r) => r.year === filter.year);
  if (filter.keyword) {
    // V399: 关键词拆分为多词（空格/逗号分隔），任一命中即算 — 修复整句匹配导致 0 条
    const terms = filter.keyword.split(/[\s,，、]+/).map((t) => t.toLowerCase()).filter(Boolean);
    const kw = filter.keyword.toLowerCase();
    filtered = filtered.filter((r) => {
      // 标题/作者命中直接算
      if (r.title.toLowerCase().includes(kw)) return true;
      if (r.authors.some((a) => a.includes(filter.keyword!))) return true;
      // 多词任一命中标题（如 "资本下乡 农村集体经济" → 命中含任一词的论文）
      if (terms.length > 1 && terms.some((t) => r.title.toLowerCase().includes(t))) return true;
      // 摘要内容命中
      const summary = readAuxContent(r.path, "摘要.md");
      if (summary && (summary.toLowerCase().includes(kw) || (terms.length > 1 && terms.some((t) => summary.toLowerCase().includes(t))))) return true;
      return false;
    });
  }

  const total = filtered.length;
  const page = filter.page ?? 1;
  const pageSize = filter.pageSize ?? 20;
  const start = (page - 1) * pageSize;
  return {
    total,
    items: filtered.slice(start, start + pageSize),
    page,
    pageSize
  };
}

function getCatalog(): LiteratureCatalog {
  const records = getRecords();
  const topics = [...new Set(records.map((r) => r.topic))].sort();
  const authors = [...new Set(records.flatMap((r) => r.authors))].filter(Boolean).sort((a, b) => a.localeCompare(b, "zh-CN"));
  const years = [...new Set(records.map((r) => r.year))].filter(Boolean).sort().reverse();
  return { topics, authors, years, total: records.length };
}

export interface PdfRecord {
  fileName: string;      // PDF 文件名（含 .pdf）
  title: string;         // 从文件名提取的标题
  author?: string;       // 从文件名提取的作者
  topic: string;         // 所属主题目录
  path: string;          // 完整路径
  indexed: boolean;      // 是否已入库（有 Markdown 6 文件）
}

// 扫描所有主题下的 PDF 文件名，建立可检索索引
let pdfCache: PdfRecord[] | null = null;

function scanAllPdfs(): PdfRecord[] {
  if (!fs.existsSync(ACADEMIC_JOURNAL_DIR)) return [];
  const topics = fs.readdirSync(ACADEMIC_JOURNAL_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const all: PdfRecord[] = [];
  for (const topic of topics) {
    const topicDir = path.join(ACADEMIC_JOURNAL_DIR, topic);
    const pdfs = findPdfsRecursive(topicDir);
    for (const pdfPath of pdfs) {
      const fileName = path.basename(pdfPath);
      // 从文件名提取标题和作者：title_作者.pdf
      let title = fileName.replace(/\.pdf$/i, "");
      let author: string | undefined;
      // 主题目录名内的 PDF（如 资本下乡/PDF/xxx.pdf）
      const parts = title.split("_");
      if (parts.length > 1) {
        author = parts[parts.length - 1];
      }
      all.push({
        fileName,
        title,
        author,
        topic,
        path: pdfPath,
        indexed: false
      });
    }
  }
  return all;
}

function findPdfsRecursive(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "Markdown") {
        results.push(...findPdfsRecursive(full));
      }
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) {
      results.push(full);
    }
  }
  return results;
}

// 标记哪些 PDF 已入库（有 Markdown 6 文件）
function markIndexedPdfs(pdfs: PdfRecord[], records: LiteratureRecord[]): PdfRecord[] {
  // 规范化：只处理 Obsidian 重名产生的数字后缀（如 " (1)"），保留有意义的括号说明
  const normalizeName = (name: string): string => {
    return name
      .replace(/\.pdf$/i, "")
      .replace(/\s*\(\d+\)/g, "")   // 去掉英文括号数字后缀 " (1)"
      .replace(/\s+/g, "");
  };
  // 1. sourcePdf 精确匹配集合
  const indexedNames = new Set<string>();
  for (const r of records) {
    if (r.sourcePdf) indexedNames.add(normalizeName(r.sourcePdf));
  }
  // 2. 标题匹配集合（处理 sourcePdf 与磁盘文件名不一致的遗留）
  const indexedTitles = new Set<string>();
  for (const r of records) {
    if (r.title) indexedTitles.add(r.title.replace(/\s+/g, ""));
  }
  // 标题匹配的 PDF 归一：去掉括号说明（标题比对宽松）
  const normalizeTitle = (title: string): string => {
    return title
      .replace(/[（(][^（()）]*[）)]/g, "")
      .replace(/\s+/g, "")
      .replace(/_/g, "");
  };
  const indexedTitleList = Array.from(indexedTitles);
  return pdfs.map((pdf) => {
    const pdfNormTitle = normalizeTitle(pdf.title);
    // 3 级匹配：sourcePdf 精确 / 标题精确 / 标题前缀（PDF 标题以入库标题开头）
    const bySource = indexedNames.has(normalizeName(pdf.fileName));
    const byExactTitle = indexedTitles.has(pdfNormTitle);
    const byPrefix = indexedTitleList.some((t) => t.length >= 8 && (pdfNormTitle.startsWith(t) || t.startsWith(pdfNormTitle)));
    return {
      ...pdf,
      indexed: bySource || byExactTitle || byPrefix
    };
  });
}

function searchPdfs(input: { topic?: string; keyword?: string; page?: number; pageSize?: number }): {
  total: number;
  items: PdfRecord[];
  page: number;
  pageSize: number;
} {
  if (!pdfCache) {
    pdfCache = scanAllPdfs();
  }
  // 每次用最新 records 重新计算已入库标记（sourcePdf 可能随时间补充）
  const indexedCache = markIndexedPdfs(pdfCache, getRecords());
  let filtered = indexedCache;
  if (input.topic) filtered = filtered.filter((p) => p.topic.includes(input.topic!));
  if (input.keyword) {
    const kw = input.keyword.toLowerCase();
    filtered = filtered.filter((p) => p.title.toLowerCase().includes(kw) || (p.author ?? "").toLowerCase().includes(kw));
  }
  const total = filtered.length;
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 20;
  const start = (page - 1) * pageSize;
  return {
    total,
    items: filtered.slice(start, start + pageSize),
    page,
    pageSize
  };
}

export const literatureService = {
  list: listLiterature,
  catalog: getCatalog,
  getRecords,
  getDetail: getLiteratureDetail,
  searchPdfs,
  scanDir: ACADEMIC_JOURNAL_DIR
};
