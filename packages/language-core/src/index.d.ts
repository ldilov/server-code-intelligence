export type FileKind = "source" | "test" | "config" | "manifest" | "doc" | "log" | "generated" | "binary" | "unknown";
export interface CandidateFile {
    absPath: string;
    relPath: string;
    basename: string;
    extension: string;
    sizeBytes: number;
    mtimeMs: number;
}
export interface DetectionSignal {
    detectorId: string;
    dimension: "kind" | "language" | "role" | "tag";
    value: string;
    confidence: number;
    reason: string;
    metadata?: Record<string, unknown>;
}
export interface FileClassification {
    kind: FileKind;
    language?: string;
    roles: string[];
    tags: string[];
    generated: boolean;
    confidence: number;
    reasons: string[];
    signals: DetectionSignal[];
}
export interface WorkspaceHint {
    originPath: string;
    sourceRoots?: string[];
    testRoots?: string[];
    packageRoots?: string[];
    evidenceRoots?: string[];
    generatedDirectories?: string[];
    ignoredDirectories?: string[];
    languages?: string[];
    buildSystems?: string[];
    metadata?: Record<string, unknown>;
}
export interface RuntimeConventions {
    sourcePatterns: string[];
    evidencePatterns: string[];
    manifestPatterns: string[];
    ignoreDirectories: string[];
    generatedPatterns: string[];
    generatedBannerPatterns: RegExp[];
    testFilePatterns: string[];
    binaryExtensions: Set<string>;
    languageByExtension: Record<string, string>;
}
export interface DetectionContext {
    workspaceRoot: string;
    runtimeConventions: RuntimeConventions;
    workspaceHints: WorkspaceHint[];
}
export interface DetectionModule {
    id: string;
    detect(candidate: CandidateFile, sourceText: string | undefined, context: DetectionContext): DetectionSignal[];
}
export interface ModuleIdentity {
    moduleIdSeed: string;
    canonicalPath: string;
    displayPath: string;
    moduleKind: "file" | "entrypoint" | "directory" | "framework-unit";
    tags: string[];
}
export interface ModuleIdentityContext {
    candidate: CandidateFile;
    classification: FileClassification;
    sourceText?: string;
}
export interface ModuleIdentityProvider {
    id: string;
    priority: number;
    resolve(context: ModuleIdentityContext): ModuleIdentity | undefined;
}
export interface ParserContextV2 {
    workspaceId: string;
    workspaceRoot: string;
    repoId: string;
    packageId?: string;
    filePath: string;
    relativePath: string;
    hash: string;
    now: string;
    classification: FileClassification;
    moduleIdentity: ModuleIdentity;
}
export interface ExtractedFactEnvelope<TFact = unknown> {
    facts: TFact;
    warnings: string[];
}
export interface LanguageAdapter<TFact = unknown> {
    id: string;
    displayName: string;
    supports(candidate: CandidateFile, classification: FileClassification): boolean;
    extract(context: ParserContextV2, sourceText: string): ExtractedFactEnvelope<TFact>;
}
export declare function normalizeSlashes(value: string): string;
export declare class AdapterRegistry {
    private readonly languageAdapters;
    private readonly identityProviders;
    constructor(languageAdapters: LanguageAdapter[], identityProviders: ModuleIdentityProvider[]);
    getLanguageAdapter(candidate: CandidateFile, classification: FileClassification): LanguageAdapter | undefined;
    resolveModuleIdentity(context: ModuleIdentityContext): ModuleIdentity;
}
export declare class FileBackedModuleIdentityProvider implements ModuleIdentityProvider {
    readonly id = "file-backed";
    readonly priority = 0;
    resolve(context: ModuleIdentityContext): ModuleIdentity;
}
export declare function summarizeSignals(signals: DetectionSignal[]): string[];
export declare function normalizeCandidate(absPath: string, workspaceRoot: string, sizeBytes: number, mtimeMs: number): CandidateFile;
//# sourceMappingURL=index.d.ts.map