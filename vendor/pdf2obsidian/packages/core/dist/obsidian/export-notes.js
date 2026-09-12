import { basename, join } from 'node:path';
import { copyFileTo, deleteFileIfExists, ensureDirectory, writeTextFile } from '../storage/file-system.js';
export async function exportNotes(input) {
    await ensureDirectory(input.documentRoot);
    // 每篇论文导出为 index/zh/original 三类笔记；original 可关闭，关闭后要清理旧文件。
    const originalNotePath = join(input.documentRoot, `${input.slug}.original.md`);
    const translatedNotePath = join(input.documentRoot, `${input.slug}.zh.md`);
    const indexNotePath = join(input.documentRoot, `${input.slug}.index.md`);
    if (input.originalNote) {
        await writeTextFile(originalNotePath, input.originalNote);
    }
    else {
        await deleteFileIfExists(originalNotePath);
    }
    await writeTextFile(translatedNotePath, input.translatedNote);
    await writeTextFile(indexNotePath, input.indexNote);
    // PDF 原件放在同一目录下，Obsidian 内部链接和用户手动归档都更直观。
    await copyFileTo(input.pdfPath, join(input.documentRoot, basename(input.pdfPath)));
    return {
        originalNotePath: input.originalNote ? originalNotePath : undefined,
        translatedNotePath,
        indexNotePath
    };
}
