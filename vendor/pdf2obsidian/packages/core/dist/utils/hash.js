import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
export async function sha256File(path) {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        const stream = createReadStream(path);
        stream.on('error', reject);
        stream.on('data', (chunk) => {
            hash.update(chunk);
        });
        stream.on('end', () => {
            resolve(`sha256:${hash.digest('hex')}`);
        });
    });
}
export function sha256Text(value) {
    return createHash('sha256').update(value).digest('hex');
}
