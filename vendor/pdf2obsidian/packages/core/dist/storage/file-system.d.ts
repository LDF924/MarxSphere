export declare function ensureDirectory(path: string): Promise<void>;
export declare function readTextFile(path: string): Promise<string>;
export declare function writeTextFile(path: string, content: string): Promise<void>;
export declare function writeJsonFile(path: string, content: unknown): Promise<void>;
export declare function copyDirectory(source: string, destination: string): Promise<void>;
export declare function copyFileTo(source: string, destination: string): Promise<void>;
export declare function deleteFileIfExists(path: string): Promise<void>;
export declare function deleteDirectory(path: string): Promise<void>;
export declare function pathExists(path: string): Promise<boolean>;
