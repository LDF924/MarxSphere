import { access, cp, mkdir, readFile, unlink, writeFile, rm } from 'node:fs/promises';
export async function ensureDirectory(path) {
    await mkdir(path, { recursive: true });
}
export async function readTextFile(path) {
    return readFile(path, 'utf8');
}
export async function writeTextFile(path, content) {
    await writeFile(path, content, 'utf8');
}
export async function writeJsonFile(path, content) {
    await writeFile(path, JSON.stringify(content, null, 2), 'utf8');
}
export async function copyDirectory(source, destination) {
    await cp(source, destination, { recursive: true, force: true });
}
export async function copyFileTo(source, destination) {
    await cp(source, destination, { force: true });
}
export async function deleteFileIfExists(path) {
    try {
        await unlink(path);
    }
    catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }
}
export async function deleteDirectory(path) {
    try {
        await rm(path, { recursive: true, force: true });
    }
    catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }
}
export async function pathExists(path) {
    try {
        await access(path);
        return true;
    }
    catch {
        return false;
    }
}
