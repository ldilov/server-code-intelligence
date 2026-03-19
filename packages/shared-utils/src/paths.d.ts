export declare function normalizePath(input: string): string;
export declare function toRelativePath(rootPath: string, targetPath: string): string;
export declare function ensureWithinRoot(rootPath: string, targetPath: string): boolean;
export declare function pathToModuleLanguage(filePath: string): string;
export declare function resolveLocalModulePath(fromFilePath: string, importText: string, candidateExtensions?: string[]): string | undefined;
export declare function globToRegExp(pattern: string): RegExp;
//# sourceMappingURL=paths.d.ts.map