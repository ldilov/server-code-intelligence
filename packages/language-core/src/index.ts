import path from "node:path";

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

export interface WorkspaceModuleCandidate {
  path: string;
  relativePath: string;
  language?: string;
}

export interface WorkspaceModuleCatalog {
  entries: WorkspaceModuleCandidate[];
  byReferenceKey: Map<string, WorkspaceModuleCandidate[]>;
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
  workspaceModuleCatalog?: WorkspaceModuleCatalog;
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

export function normalizeSlashes(value: string): string {
  return value.replaceAll("\\", "/");
}

function withoutExtension(value: string): string {
  const normalized = normalizeSlashes(value);
  const extension = path.posix.extname(normalized);
  return extension.length > 0 ? normalized.slice(0, -extension.length) : normalized;
}

function normalizeModuleReferenceKey(value: string): string {
  return withoutExtension(value)
    .replace(/[.:]+/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
}

function pushModuleReferenceCandidate(
  index: Map<string, WorkspaceModuleCandidate[]>,
  referenceKey: string,
  candidate: WorkspaceModuleCandidate
): void {
  if (!referenceKey) {
    return;
  }

  const segments = referenceKey.split("/").filter(Boolean);
  for (let indexStart = 0; indexStart < segments.length; indexStart += 1) {
    const suffix = segments.slice(indexStart).join("/");
    const existing = index.get(suffix) ?? [];
    if (!existing.some((entry) => entry.path === candidate.path)) {
      existing.push(candidate);
      index.set(suffix, existing);
    }
  }
}

function toPathSegments(value: string): string[] {
  return normalizeSlashes(value).toLowerCase().split("/").filter(Boolean);
}

function commonPrefixLength(left: string[], right: string[]): number {
  const max = Math.min(left.length, right.length);
  let count = 0;
  while (count < max && left[count] === right[count]) {
    count += 1;
  }
  return count;
}

function rankWorkspaceModuleCandidate(
  candidate: WorkspaceModuleCandidate,
  normalizedReference: string,
  options: ResolveWorkspaceModuleReferenceOptions
): number {
  const candidateReference = normalizeModuleReferenceKey(candidate.relativePath);
  const candidateDirectoryReference =
    path.posix.basename(withoutExtension(normalizeSlashes(candidate.relativePath))).toLowerCase() === "init"
      ? normalizeModuleReferenceKey(path.posix.dirname(withoutExtension(normalizeSlashes(candidate.relativePath))))
      : undefined;
  const candidateBasename = path.posix.basename(candidateReference);
  const referenceBasename = path.posix.basename(normalizedReference);
  let score = 0;

  if (options.language && candidate.language === options.language) {
    score += 30;
  }

  if (candidateReference === normalizedReference) {
    score += 20;
  }

  if (candidateBasename === referenceBasename) {
    score += 10;
  }

  if (candidateDirectoryReference === normalizedReference) {
    score += 20;
  }

  if (candidateDirectoryReference && path.posix.basename(candidateDirectoryReference) === referenceBasename) {
    score += 10;
  }

  if (options.fromFilePath) {
    const sourcePath = normalizeSlashes(options.fromFilePath);
    const sourceDirectorySegments = toPathSegments(path.posix.dirname(sourcePath));
    const candidateDirectorySegments = toPathSegments(path.posix.dirname(candidate.path));
    const sharedSegments = commonPrefixLength(sourceDirectorySegments, candidateDirectorySegments);
    const directoryDistance = sourceDirectorySegments.length + candidateDirectorySegments.length - (sharedSegments * 2);

    score += sharedSegments * 4;
    score -= directoryDistance;

    if (path.posix.extname(candidate.path).toLowerCase() === path.posix.extname(sourcePath).toLowerCase()) {
      score += 5;
    }
  }

  return score;
}

export interface ResolveWorkspaceModuleReferenceOptions {
  fromFilePath?: string;
  language?: string;
}

export function createWorkspaceModuleCatalog(entries: WorkspaceModuleCandidate[]): WorkspaceModuleCatalog {
  const byReferenceKey = new Map<string, WorkspaceModuleCandidate[]>();

  for (const entry of entries) {
    const normalizedRelativePath = normalizeSlashes(entry.relativePath);
    const normalizedReference = normalizeModuleReferenceKey(normalizedRelativePath);
    pushModuleReferenceCandidate(byReferenceKey, normalizedReference, entry);

    const fileStem = path.posix.basename(withoutExtension(normalizedRelativePath)).toLowerCase();
    if (fileStem === "init") {
      const directoryReference = normalizeModuleReferenceKey(path.posix.dirname(withoutExtension(normalizedRelativePath)));
      pushModuleReferenceCandidate(byReferenceKey, directoryReference, entry);
    }
  }

  return {
    entries: [...entries],
    byReferenceKey
  };
}

export function resolveWorkspaceModuleReference(
  catalog: WorkspaceModuleCatalog | undefined,
  referenceText: string,
  options: ResolveWorkspaceModuleReferenceOptions = {}
): WorkspaceModuleCandidate | undefined {
  if (!catalog) {
    return undefined;
  }

  const normalizedReference = normalizeModuleReferenceKey(referenceText);
  if (!normalizedReference) {
    return undefined;
  }

  const candidates = (catalog.byReferenceKey.get(normalizedReference) ?? [])
    .filter((candidate) => candidate.path !== options.fromFilePath);

  if (candidates.length === 0) {
    return undefined;
  }

  return [...candidates]
    .sort((left, right) =>
      rankWorkspaceModuleCandidate(right, normalizedReference, options) -
        rankWorkspaceModuleCandidate(left, normalizedReference, options) ||
      left.path.localeCompare(right.path)
    )[0];
}

export class AdapterRegistry {
  public constructor(
    private readonly languageAdapters: LanguageAdapter[],
    private readonly identityProviders: ModuleIdentityProvider[]
  ) {}

  public getLanguageAdapter(candidate: CandidateFile, classification: FileClassification): LanguageAdapter | undefined {
    return this.languageAdapters.find((adapter) => adapter.supports(candidate, classification));
  }

  public resolveModuleIdentity(context: ModuleIdentityContext): ModuleIdentity {
    const providers = [...this.identityProviders].sort((left, right) => right.priority - left.priority);
    for (const provider of providers) {
      const resolved = provider.resolve(context);
      if (resolved) {
        return resolved;
      }
    }

    return {
      moduleIdSeed: context.candidate.absPath,
      canonicalPath: context.candidate.absPath,
      displayPath: context.candidate.relPath,
      moduleKind: "file",
      tags: [...context.classification.tags]
    };
  }
}

export class FileBackedModuleIdentityProvider implements ModuleIdentityProvider {
  public readonly id = "file-backed";
  public readonly priority = 0;

  public resolve(context: ModuleIdentityContext): ModuleIdentity {
    return {
      moduleIdSeed: context.candidate.absPath,
      canonicalPath: context.candidate.absPath,
      displayPath: context.candidate.relPath,
      moduleKind: "file",
      tags: [...context.classification.tags]
    };
  }
}

export function summarizeSignals(signals: DetectionSignal[]): string[] {
  return signals.map((signal) => `${signal.detectorId}: ${signal.reason}`);
}

export function normalizeCandidate(absPath: string, workspaceRoot: string, sizeBytes: number, mtimeMs: number): CandidateFile {
  const normalizedAbsPath = normalizeSlashes(absPath);
  const relPath = normalizeSlashes(path.relative(workspaceRoot, absPath));
  return {
    absPath: normalizedAbsPath,
    relPath,
    basename: path.basename(absPath),
    extension: path.extname(absPath).toLowerCase(),
    sizeBytes,
    mtimeMs
  };
}
