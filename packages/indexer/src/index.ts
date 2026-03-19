import { readFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import ignore from "ignore";
import type {
  ExtractedFileFact,
  FileRecord,
  ModuleRecord,
  PackageRecord,
  RepositoryRecord,
  SummaryRecord,
  WorkspaceRecord
} from "@local-engineering-brain/core-types";
import { evaluateArchitectureRules, loadArchitectureRules } from "@local-engineering-brain/architecture-rules";
import {
  FileClassifier,
  createDefaultDetectors,
  createRuntimeConventions,
  discoverCandidateFiles,
  readCandidateText
} from "@local-engineering-brain/discovery-engine";
import { GitIntelCollector } from "@local-engineering-brain/git-intel";
import {
  AdapterRegistry,
  FileBackedModuleIdentityProvider,
  createWorkspaceModuleCatalog,
  type CandidateFile,
  type FileClassification,
  type ParserContextV2,
  type WorkspaceHint
} from "@local-engineering-brain/language-core";
import { CSharpLanguageAdapter } from "@local-engineering-brain/language-csharp";
import { LuaLanguageAdapter } from "@local-engineering-brain/language-lua";
import { TypeScriptExtractor, TypeScriptLanguageAdapter } from "@local-engineering-brain/language-ts";
import { collectConfiguredLogs, loadLogIntelConfig } from "@local-engineering-brain/log-intel";
import { collectManifestHints } from "@local-engineering-brain/manifest-intel";
import {
  normalizePath,
  nowIso,
  pathToModuleLanguage,
  sha256,
  stableId
} from "@local-engineering-brain/shared-utils";
import { BrainDatabase } from "@local-engineering-brain/storage-sqlite";
import { TestIntelExtractor } from "@local-engineering-brain/test-intel";

const defaultIgnorePatterns = ["**/node_modules/**", "**/dist/**", "**/build/**", "**/coverage/**"];
const indexableKinds = new Set<FileClassification["kind"]>(["source", "test", "config", "manifest", "doc"]);

export interface IndexWorkspaceResult {
  workspaceId: string;
  filesDiscovered: number;
  filesIndexed: number;
  filesSkipped: number;
  warnings: string[];
}

interface ClassifiedCandidate {
  candidate: CandidateFile;
  classification: FileClassification;
  sourceText?: string;
}

function detectRepository(workspace: WorkspaceRecord): RepositoryRecord {
  const now = nowIso();
  return {
    id: stableId("repo", workspace.id, workspace.rootPath),
    workspaceId: workspace.id,
    rootPath: workspace.rootPath,
    vcsType: "none",
    createdAt: now,
    updatedAt: now
  };
}

async function readIgnoreMatcher(rootPath: string, ignoreDirectories: readonly string[]) {
  const matcher = ignore();
  try {
    const gitIgnore = await readFile(path.join(rootPath, ".gitignore"), "utf8");
    matcher.add(gitIgnore);
  } catch {
    // No gitignore is fine for greenfield repos.
  }

  matcher.add(
    [...ignoreDirectories].flatMap((directory) => {
      const normalized = directory.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
      return normalized.length > 0 ? [normalized, `${normalized}/`, `**/${normalized}`, `**/${normalized}/**`] : [];
    })
  );
  return matcher;
}

async function discoverPackages(
  workspace: WorkspaceRecord,
  repo: RepositoryRecord,
  workspaceHints: WorkspaceHint[]
): Promise<PackageRecord[]> {
  const now = nowIso();
  const recordsByRoot = new Map<string, PackageRecord>();

  const upsertPackage = (rootPath: string, manifestPath: string, name: string, packageManager: string) => {
    const normalizedRoot = normalizePath(rootPath);
    const normalizedManifestPath = normalizePath(manifestPath);
    recordsByRoot.set(normalizedRoot, {
      id: stableId("package", workspace.id, normalizedRoot),
      workspaceId: workspace.id,
      repoId: repo.id,
      name,
      rootPath: normalizedRoot,
      manifestPath: normalizedManifestPath,
      packageManager,
      createdAt: now,
      updatedAt: now
    });
  };

  const packageManifestPaths = await fg(["**/package.json"], {
    cwd: workspace.rootPath,
    absolute: true,
    suppressErrors: true,
    ignore: defaultIgnorePatterns
  });

  for (const manifestPath of packageManifestPaths) {
    const normalizedManifestPath = normalizePath(manifestPath);
    const rootPath = normalizePath(path.dirname(normalizedManifestPath));
    try {
      const manifest = JSON.parse(await readFile(normalizedManifestPath, "utf8")) as { name?: string; packageManager?: string };
      upsertPackage(rootPath, normalizedManifestPath, manifest.name ?? path.basename(rootPath), manifest.packageManager ?? "pnpm");
    } catch {
      upsertPackage(rootPath, normalizedManifestPath, path.basename(rootPath), "pnpm");
    }
  }

  for (const hint of workspaceHints) {
    const manifestPath = hint.originPath
      ? normalizePath(path.join(workspace.rootPath, hint.originPath))
      : normalizePath(path.join(workspace.rootPath, "workspace.manifest"));
    const packageRoots = (hint.packageRoots ?? []).filter((candidate) => candidate.length > 0);
    for (const packageRoot of packageRoots) {
      const absoluteRoot = normalizePath(path.join(workspace.rootPath, packageRoot));
      if (!recordsByRoot.has(absoluteRoot)) {
        upsertPackage(absoluteRoot, manifestPath, path.basename(absoluteRoot), hint.buildSystems?.[0] ?? "workspace");
      }
    }
  }

  if (recordsByRoot.size === 0) {
    upsertPackage(workspace.rootPath, path.join(workspace.rootPath, "package.json"), path.basename(workspace.rootPath), "workspace");
  }

  return [...recordsByRoot.values()].sort((left, right) => right.rootPath.length - left.rootPath.length);
}

function findNearestPackage(filePath: string, packages: PackageRecord[]): PackageRecord | undefined {
  return packages.find((pkg) => filePath === pkg.rootPath || filePath.startsWith(`${pkg.rootPath}/`));
}

function isIndexableClassification(classification: FileClassification): boolean {
  return indexableKinds.has(classification.kind);
}

function shouldRunTestExtraction(classification: FileClassification): boolean {
  return classification.kind === "test" && ["typescript", "javascript"].includes(classification.language ?? "");
}

function buildEvidenceSummary(relativePath: string, classification: FileClassification, language: string): string {
  const base = `${language} ${classification.kind} file indexed as file-level evidence`;
  const reason = classification.reasons[0];
  return reason ? `${base} for ${relativePath}. ${reason}.` : `${base} for ${relativePath}.`;
}

function buildEvidenceFact(context: ParserContextV2): ExtractedFileFact {
  const fileId = stableId("file", context.workspaceId, context.filePath);
  const moduleId = stableId("module", context.workspaceId, context.filePath);
  const language = context.classification.language ?? pathToModuleLanguage(context.filePath);
  const summaryText = buildEvidenceSummary(context.relativePath, context.classification, language);
  const file: FileRecord = {
    id: fileId,
    workspaceId: context.workspaceId,
    repoId: context.repoId,
    packageId: context.packageId,
    path: context.filePath,
    language,
    summary: summaryText,
    authored: !context.classification.generated,
    hash: context.hash,
    updatedAt: context.now
  };
  const module: ModuleRecord = {
    id: moduleId,
    workspaceId: context.workspaceId,
    fileId,
    packageId: context.packageId,
    canonicalPath: context.moduleIdentity.canonicalPath,
    language,
    summary: summaryText,
    publicExports: [],
    inboundDependencyCount: 0,
    outboundDependencyCount: 0,
    updatedAt: context.now
  };
  const edges: ExtractedFileFact["edges"] = [
    {
      id: stableId("edge", "contains", fileId, moduleId, context.filePath),
      workspaceId: context.workspaceId,
      sourceId: fileId,
      sourceType: "file",
      targetId: moduleId,
      targetType: "module",
      type: "contains",
      ownerFilePath: context.filePath,
      confidence: 1,
      createdAt: context.now,
      updatedAt: context.now
    }
  ];

  if (context.packageId) {
    edges.push({
      id: stableId("edge", "belongs_to_package", moduleId, context.packageId, context.filePath),
      workspaceId: context.workspaceId,
      sourceId: moduleId,
      sourceType: "module",
      targetId: context.packageId,
      targetType: "package",
      type: "belongs_to_package",
      ownerFilePath: context.filePath,
      confidence: 1,
      createdAt: context.now,
      updatedAt: context.now
    });
  }

  const summary: SummaryRecord = {
    id: stableId("summary", context.workspaceId, moduleId),
    workspaceId: context.workspaceId,
    entityId: moduleId,
    entityType: "module",
    summary: summaryText,
    source: "indexer-evidence",
    updatedAt: context.now
  };

  return {
    file,
    module,
    symbols: [],
    edges,
    summary,
    warnings: []
  };
}

export class WorkspaceIndexer {
  private readonly tsExtractor = new TypeScriptExtractor();
  private readonly tsAdapter = new TypeScriptLanguageAdapter(this.tsExtractor);
  private readonly csharpAdapter = new CSharpLanguageAdapter();
  private readonly luaAdapter = new LuaLanguageAdapter();
  private readonly registry = new AdapterRegistry([this.tsAdapter, this.csharpAdapter, this.luaAdapter], [new FileBackedModuleIdentityProvider()]);
  private readonly classifier = new FileClassifier(createDefaultDetectors());
  private readonly testExtractor = new TestIntelExtractor();
  private readonly gitCollector = new GitIntelCollector();
  private readonly evidenceExtractorVersion = "indexer-evidence-v2";
  private readonly routingVersion = "indexer-routing-v2";
  private readonly testIntelVersion = "test-intel-v1";

  public constructor(private readonly database: BrainDatabase) {}

  public async indexWorkspace(workspace: WorkspaceRecord): Promise<IndexWorkspaceResult> {
    const repository = detectRepository(workspace);
    const workspaceHints = await collectManifestHints(workspace.rootPath);
    const runtimeConventions = createRuntimeConventions(workspaceHints);

    this.database.upsertWorkspace(workspace);
    this.database.upsertRepository(repository);

    const packages = await discoverPackages(workspace, repository, workspaceHints);
    this.database.replacePackages(workspace.id, packages);

    const matcher = await readIgnoreMatcher(workspace.rootPath, runtimeConventions.ignoreDirectories);
    const detectionContext = {
      workspaceRoot: workspace.rootPath,
      runtimeConventions,
      workspaceHints
    };
    const discoveredCandidates = (await discoverCandidateFiles(workspace.rootPath, runtimeConventions))
      .filter((candidate) => !matcher.ignores(candidate.relPath))
      .sort((left, right) => left.relPath.localeCompare(right.relPath));

    const classifiedCandidates: ClassifiedCandidate[] = [];
    for (const candidate of discoveredCandidates) {
      const sourceText = await readCandidateText(candidate, runtimeConventions);
      classifiedCandidates.push({
        candidate,
        classification: this.classifier.classify(candidate, sourceText, detectionContext),
        sourceText
      });
    }

    const workspaceModuleCatalog = createWorkspaceModuleCatalog(
      classifiedCandidates
        .filter((entry) => isIndexableClassification(entry.classification))
        .map(({ candidate, classification }) => ({
          path: candidate.absPath,
          relativePath: candidate.relPath,
          language: classification.language
        }))
    );

    const knownPaths = new Set(
      classifiedCandidates
        .filter((entry) => isIndexableClassification(entry.classification))
        .map((entry) => entry.candidate.absPath)
    );

    for (const file of this.database.listWorkspaceFiles(workspace.id)) {
      if (!knownPaths.has(file.path)) {
        this.database.deleteModuleByPath(workspace.id, file.path);
        this.database.deleteTestFactsByPath(workspace.id, file.path);
      }
    }

    const jobId = this.database.startIndexJob(workspace.id, classifiedCandidates.length, "discovery", "Discovering workspace files");
    const warnings: string[] = [];
    let filesIndexed = 0;
    let filesSkipped = 0;
    let filesProcessed = 0;

    for (const entry of classifiedCandidates) {
      const { candidate, classification, sourceText } = entry;
      this.database.updateIndexJob(
        jobId,
        "running",
        "indexing",
        `Indexing ${candidate.relPath}`,
        filesProcessed,
        classifiedCandidates.length
      );

      if (!isIndexableClassification(classification)) {
        filesSkipped += 1;
        filesProcessed += 1;
        continue;
      }

      if (sourceText === undefined) {
        warnings.push(`Failed to read ${candidate.relPath}; keeping last known indexed facts.`);
        filesProcessed += 1;
        continue;
      }

      const contentHash = sha256(sourceText);
      const assignedPackage = findNearestPackage(candidate.absPath, packages);
      const moduleIdentity = this.registry.resolveModuleIdentity({
        candidate,
        classification,
        sourceText
      });
      const context: ParserContextV2 = {
        workspaceId: workspace.id,
        workspaceRoot: workspace.rootPath,
        repoId: repository.id,
        packageId: assignedPackage?.id,
        filePath: candidate.absPath,
        relativePath: candidate.relPath,
        hash: contentHash,
        now: new Date(candidate.mtimeMs).toISOString(),
        classification,
        moduleIdentity,
        workspaceModuleCatalog
      };
      const adapter = this.registry.getLanguageAdapter(candidate, classification);
      const existingHash = this.database.getFileHash(workspace.id, candidate.absPath);
      const extractorVersion = adapter?.id === this.tsAdapter.id
        ? `${this.tsExtractor.extractorVersion}|${this.testIntelVersion}`
        : adapter?.id === this.csharpAdapter.id
          ? this.csharpAdapter.extractorVersion
          : adapter?.id === this.luaAdapter.id
            ? this.luaAdapter.extractorVersion
          : `${this.evidenceExtractorVersion}:${classification.kind}:${classification.language ?? "unknown"}`;
      const parserVersion = adapter?.id === this.tsAdapter.id
        ? `${this.tsExtractor.parserVersion}|${this.routingVersion}`
        : adapter?.id === this.csharpAdapter.id
          ? `${this.csharpAdapter.parserVersion}|${this.routingVersion}`
          : adapter?.id === this.luaAdapter.id
            ? `${this.luaAdapter.parserVersion}|${this.routingVersion}`
          : this.routingVersion;

      if (
        existingHash &&
        existingHash.contentHash === contentHash &&
        existingHash.extractorVersion === extractorVersion &&
        existingHash.parserVersion === parserVersion
      ) {
        filesSkipped += 1;
        filesProcessed += 1;
        continue;
      }

      try {
        const extraction = adapter
          ? (adapter.extract(context, sourceText) as { facts: ExtractedFileFact; warnings: string[] })
          : { facts: buildEvidenceFact(context), warnings: [] as string[] };
        const extracted = extraction.facts;
        this.database.replaceFileFact(extracted);

        if (shouldRunTestExtraction(classification)) {
          const testFact = this.testExtractor.extract(
            {
              workspaceId: context.workspaceId,
              workspaceRoot: context.workspaceRoot,
              repoId: context.repoId,
              packageId: context.packageId,
              filePath: context.filePath,
              relativePath: context.relativePath,
              hash: context.hash,
              now: context.now
            },
            sourceText
          );

          if (testFact) {
            this.database.replaceTestFact(workspace.id, candidate.absPath, testFact);
            warnings.push(...testFact.warnings);
          } else {
            this.database.deleteTestFactsByPath(workspace.id, candidate.absPath);
          }
        } else {
          this.database.deleteTestFactsByPath(workspace.id, candidate.absPath);
        }

        this.database.recordFileHash(workspace.id, candidate.absPath, contentHash, extractorVersion, parserVersion);
        warnings.push(...extraction.warnings);
        warnings.push(...extracted.warnings);
        filesIndexed += 1;
      } catch (error) {
        warnings.push(`Failed to parse ${candidate.relPath}: ${error instanceof Error ? error.message : String(error)}`);
      }

      filesProcessed += 1;
    }

    const gitSnapshot = this.gitCollector.collect(workspace.rootPath, workspace.id, repository.id);
    const repoNow = nowIso();
    this.database.upsertRepository({
      ...repository,
      vcsType: gitSnapshot.isRepository ? "git" : "none",
      branchName: gitSnapshot.branchName,
      updatedAt: repoNow
    });
    this.database.replaceCommits(workspace.id, repository.id, gitSnapshot.recentCommits);

    const changedFiles = gitSnapshot.changedFiles.map((file) => ({
      ...file,
      path: normalizePath(path.join(workspace.rootPath, file.path)),
      previousPath: file.previousPath ? normalizePath(path.join(workspace.rootPath, file.previousPath)) : undefined
    }));
    const changedPaths = [...new Set(changedFiles.flatMap((file) => [file.path, file.previousPath].filter(Boolean) as string[]))];
    const changedModules = this.database.listModulesByPaths(workspace.id, changedPaths);
    const changedSymbolIds = changedModules.flatMap((module) => this.database.listModuleSymbols(module.id).map((symbol) => symbol.id));
    this.database.replaceChangeGroup(
      {
        id: stableId("change-group", workspace.id, gitSnapshot.branchName ?? "detached"),
        workspaceId: workspace.id,
        repoId: repository.id,
        branchName: gitSnapshot.branchName,
        changedFiles,
        source: "working_tree",
        updatedAt: repoNow
      },
      changedModules.map((module) => module.id),
      changedSymbolIds
    );
    warnings.push(...gitSnapshot.notes);

    const architectureConfig = await loadArchitectureRules(workspace.rootPath);
    const architectureViolations = evaluateArchitectureRules({
      workspaceId: workspace.id,
      workspaceRoot: workspace.rootPath,
      modules: this.database.listWorkspaceModules(workspace.id),
      importEdges: this.database.listImportEdges(workspace.id),
      config: architectureConfig
    });
    this.database.replaceArchitectureViolations(workspace.id, architectureViolations);

    const logConfig = await loadLogIntelConfig(workspace.rootPath);
    const logCollection = await collectConfiguredLogs(workspace.rootPath, workspace.id, logConfig);
    this.database.replaceWorkspaceLogs(workspace.id, logCollection.events, logCollection.incidents);
    warnings.push(...logCollection.warnings);

    this.database.touchWorkspaceIndexedAt(workspace.id);
    this.database.updateIndexJob(
      jobId,
      "completed",
      "complete",
      `Indexed ${filesIndexed} file(s); skipped ${filesSkipped}.`,
      filesProcessed,
      classifiedCandidates.length
    );

    return {
      workspaceId: workspace.id,
      filesDiscovered: classifiedCandidates.length,
      filesIndexed,
      filesSkipped,
      warnings
    };
  }
}
