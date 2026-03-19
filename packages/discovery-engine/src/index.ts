import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type {
  CandidateFile,
  DetectionContext,
  DetectionModule,
  DetectionSignal,
  FileClassification,
  RuntimeConventions,
  WorkspaceHint
} from "@local-engineering-brain/language-core";
import { normalizeCandidate, normalizeSlashes, summarizeSignals } from "@local-engineering-brain/language-core";
import {
  defaultBinaryExtensions,
  defaultEvidenceDiscoveryPatterns,
  defaultGeneratedBannerPatterns,
  defaultGeneratedPatterns,
  defaultLanguageByExtension,
  defaultManifestDiscoveryPatterns,
  defaultSourceCodeDiscoveryPatterns,
  defaultTestFilePatterns,
  defaultWorkspaceIgnoreDirectories,
  defaultWorkspaceLogDiscoveryDirectoryHints,
  defaultWorkspaceLogDiscoveryExtensions,
  defaultWorkspaceLogDiscoveryNamePattern,
  globToRegExp
} from "@local-engineering-brain/shared-utils";

function scoreSignals(signals: DetectionSignal[], dimension: DetectionSignal["dimension"]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const signal of signals) {
    if (signal.dimension !== dimension) {
      continue;
    }
    totals.set(signal.value, (totals.get(signal.value) ?? 0) + signal.confidence);
  }
  return totals;
}

function pickHighest(scores: Map<string, number>): { value?: string; score: number } {
  let bestValue: string | undefined;
  let bestScore = 0;
  for (const [value, score] of scores) {
    if (score > bestScore) {
      bestValue = value;
      bestScore = score;
    }
  }
  return { value: bestValue, score: bestScore };
}

export function createRuntimeConventions(workspaceHints: WorkspaceHint[]): RuntimeConventions {
  const inferredGeneratedPatterns = workspaceHints
    .flatMap((hint) => hint.generatedDirectories ?? [])
    .filter(Boolean)
    .map((directory) => `${normalizeSlashes(directory)}/**`);
  const inferredIgnoreDirectories = workspaceHints.flatMap((hint) => hint.ignoredDirectories ?? []).filter(Boolean);

  return {
    sourcePatterns: [...defaultSourceCodeDiscoveryPatterns],
    evidencePatterns: [...defaultEvidenceDiscoveryPatterns],
    manifestPatterns: [...defaultManifestDiscoveryPatterns],
    ignoreDirectories: [...new Set([...defaultWorkspaceIgnoreDirectories, ...inferredIgnoreDirectories])],
    generatedPatterns: [...new Set([...defaultGeneratedPatterns, ...inferredGeneratedPatterns])],
    generatedBannerPatterns: [...defaultGeneratedBannerPatterns],
    testFilePatterns: [...defaultTestFilePatterns],
    binaryExtensions: new Set(defaultBinaryExtensions),
    languageByExtension: { ...defaultLanguageByExtension }
  };
}

function isUnderHintRoots(relativePath: string, roots: string[]): boolean {
  const normalized = normalizeSlashes(relativePath).toLowerCase();
  return roots.some((root) => {
    const candidate = normalizeSlashes(root).toLowerCase();
    return candidate.length > 0 && (normalized === candidate || normalized.startsWith(`${candidate}/`));
  });
}

export async function discoverCandidateFiles(workspaceRoot: string, runtimeConventions: RuntimeConventions): Promise<CandidateFile[]> {
  const patterns = [...new Set([...runtimeConventions.sourcePatterns, ...runtimeConventions.evidencePatterns, ...runtimeConventions.manifestPatterns])];
  const absolutePaths = await fg(patterns, {
    cwd: workspaceRoot,
    absolute: true,
    onlyFiles: true,
    dot: true,
    suppressErrors: true,
    ignore: runtimeConventions.ignoreDirectories.map((directory) => `**/${directory}/**`)
  });

  const candidates: CandidateFile[] = [];
  for (const absolutePath of absolutePaths) {
    try {
      const fileStat = await stat(absolutePath);
      candidates.push(normalizeCandidate(absolutePath, workspaceRoot, fileStat.size, fileStat.mtimeMs));
    } catch {
      continue;
    }
  }
  return candidates;
}

export class PathPatternDetector implements DetectionModule {
  public readonly id = "path-patterns";

  public detect(candidate: CandidateFile, _sourceText: string | undefined, context: DetectionContext): DetectionSignal[] {
    const rel = normalizeSlashes(candidate.relPath);
    const signals: DetectionSignal[] = [];

    if (context.runtimeConventions.generatedPatterns.some((pattern) => globToRegExp(pattern).test(rel))) {
      signals.push({ detectorId: this.id, dimension: "kind", value: "generated", confidence: 0.95, reason: `matched generated pattern for ${rel}` });
    }

    if (context.runtimeConventions.manifestPatterns.some((pattern) => globToRegExp(pattern).test(rel))) {
      signals.push({ detectorId: this.id, dimension: "kind", value: "manifest", confidence: 0.95, reason: `matched manifest pattern for ${rel}` });
    }

    if (context.runtimeConventions.sourcePatterns.some((pattern) => globToRegExp(pattern).test(rel))) {
      signals.push({ detectorId: this.id, dimension: "kind", value: "source", confidence: 0.45, reason: `matched source pattern for ${rel}` });
    }

    if (context.runtimeConventions.evidencePatterns.some((pattern) => globToRegExp(pattern).test(rel))) {
      const evidenceKind = [".md", ".mdx", ".rst", ".adoc", ".txt"].includes(candidate.extension) ? "doc" : "config";
      signals.push({ detectorId: this.id, dimension: "kind", value: evidenceKind, confidence: 0.4, reason: `matched evidence pattern for ${rel}` });
    }

    const language = context.runtimeConventions.languageByExtension[candidate.extension];
    if (language) {
      signals.push({ detectorId: this.id, dimension: "language", value: language, confidence: 0.5, reason: `extension ${candidate.extension} maps to ${language}` });
    }

    return signals;
  }
}

export class GeneratedBannerDetector implements DetectionModule {
  public readonly id = "generated-banner";

  public detect(candidate: CandidateFile, sourceText: string | undefined, context: DetectionContext): DetectionSignal[] {
    if (!sourceText) {
      return [];
    }
    const firstChunk = sourceText.split(/\r?\n/).slice(0, 20).join("\n");
    if (!context.runtimeConventions.generatedBannerPatterns.some((pattern) => pattern.test(firstChunk))) {
      return [];
    }
    return [{ detectorId: this.id, dimension: "kind", value: "generated", confidence: 0.98, reason: `${candidate.relPath} contains a generated-file banner` }];
  }
}

export class BinaryExtensionDetector implements DetectionModule {
  public readonly id = "binary-extension";

  public detect(candidate: CandidateFile, _sourceText: string | undefined, context: DetectionContext): DetectionSignal[] {
    if (!context.runtimeConventions.binaryExtensions.has(candidate.extension)) {
      return [];
    }
    return [{ detectorId: this.id, dimension: "kind", value: "binary", confidence: 1, reason: `${candidate.basename} has a binary extension` }];
  }
}

export class TestHeuristicsDetector implements DetectionModule {
  public readonly id = "test-heuristics";

  public detect(candidate: CandidateFile, sourceText: string | undefined, context: DetectionContext): DetectionSignal[] {
    const rel = normalizeSlashes(candidate.relPath).toLowerCase();
    const signals: DetectionSignal[] = [];

    if (context.runtimeConventions.testFilePatterns.some((pattern) => globToRegExp(pattern).test(rel)) || /(^|\/)(tests?|__tests__|spec)\//.test(rel)) {
      signals.push({ detectorId: this.id, dimension: "kind", value: "test", confidence: 0.9, reason: `${candidate.relPath} looks like a test path` });
      signals.push({ detectorId: this.id, dimension: "role", value: "test", confidence: 0.8, reason: "test role inferred from path" });
    }

    if (sourceText && /(describe\s*\(|it\s*\(|test\s*\(|pytest|unittest|xunit|nunit|mstest)/i.test(sourceText)) {
      signals.push({ detectorId: this.id, dimension: "kind", value: "test", confidence: 0.75, reason: "test framework markers found in file content" });
    }

    if (isUnderHintRoots(candidate.relPath, context.workspaceHints.flatMap((hint) => hint.testRoots ?? []))) {
      signals.push({ detectorId: this.id, dimension: "kind", value: "test", confidence: 0.65, reason: `${candidate.relPath} is under an inferred test root` });
    }

    return signals;
  }
}

export class LogHeuristicsDetector implements DetectionModule {
  public readonly id = "log-heuristics";

  public detect(candidate: CandidateFile, sourceText: string | undefined): DetectionSignal[] {
    const rel = normalizeSlashes(candidate.relPath).toLowerCase();
    const fileName = path.basename(rel);
    const looksLikeLogName = defaultWorkspaceLogDiscoveryNamePattern.test(fileName);
    const looksLikeLogDir = defaultWorkspaceLogDiscoveryDirectoryHints.some((hint) => rel.includes(`${hint.toLowerCase()}/`) || rel.startsWith(`${hint.toLowerCase()}/`));
    const looksLikeLogExtension = defaultWorkspaceLogDiscoveryExtensions.some((extension) => fileName.endsWith(extension));
    const looksLikeContent = Boolean(sourceText && /(trace|debug|info|warn|error|fatal)/i.test(sourceText.slice(0, 512)));

    if (!looksLikeLogName && !looksLikeLogDir && !looksLikeLogExtension && !looksLikeContent) {
      return [];
    }

    return [{ detectorId: this.id, dimension: "kind", value: "log", confidence: 0.8, reason: `${candidate.relPath} resembles a log file` }];
  }
}

export class DocumentHeuristicsDetector implements DetectionModule {
  public readonly id = "document-heuristics";

  public detect(candidate: CandidateFile, sourceText: string | undefined): DetectionSignal[] {
    const rel = normalizeSlashes(candidate.relPath).toLowerCase();
    const signals: DetectionSignal[] = [];

    if ([".md", ".mdx", ".rst", ".adoc", ".txt"].includes(candidate.extension)) {
      signals.push({ detectorId: this.id, dimension: "kind", value: "doc", confidence: 0.7, reason: `${candidate.basename} looks like documentation` });
    }

    if (/(^|\/)(docs?|adr|architecture|decision)s?(\/|$)/.test(rel)) {
      signals.push({ detectorId: this.id, dimension: "kind", value: "doc", confidence: 0.75, reason: `${candidate.relPath} is under a docs or ADR path` });
    }

    if (sourceText && /^#\s+/m.test(sourceText.slice(0, 500))) {
      signals.push({ detectorId: this.id, dimension: "kind", value: "doc", confidence: 0.45, reason: "markdown-like heading found near file start" });
    }

    return signals;
  }
}

export class ConfigHeuristicsDetector implements DetectionModule {
  public readonly id = "config-heuristics";

  public detect(candidate: CandidateFile, sourceText: string | undefined): DetectionSignal[] {
    const base = candidate.basename.toLowerCase();
    const signals: DetectionSignal[] = [];

    if ([".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".conf", ".config"].includes(candidate.extension)) {
      signals.push({ detectorId: this.id, dimension: "kind", value: "config", confidence: 0.65, reason: `${candidate.basename} has a common config extension` });
    }

    if (["dockerfile", "makefile", "cmakelists.txt"].includes(base) || /config|settings|compose|workspace|project/i.test(base)) {
      signals.push({ detectorId: this.id, dimension: "kind", value: "config", confidence: 0.7, reason: `${candidate.basename} looks like build or config metadata` });
    }

    if (sourceText && /("scripts"\s*:|\[tool\.|<project>|plugins\s*\{|services\s*:|apiVersion\s*:)/i.test(sourceText.slice(0, 800))) {
      signals.push({ detectorId: this.id, dimension: "kind", value: "config", confidence: 0.55, reason: "content resembles configuration or manifest data" });
    }

    return signals;
  }
}

export class FileClassifier {
  public constructor(private readonly detectors: DetectionModule[]) {}

  public classify(candidate: CandidateFile, sourceText: string | undefined, context: DetectionContext): FileClassification {
    const signals = this.detectors.flatMap((detector) => detector.detect(candidate, sourceText, context));
    const kindScores = scoreSignals(signals, "kind");
    const languageScores = scoreSignals(signals, "language");
    const roleScores = scoreSignals(signals, "role");
    const tagScores = scoreSignals(signals, "tag");
    const bestKind = pickHighest(kindScores);
    const bestLanguage = pickHighest(languageScores);
    const generated = (kindScores.get("generated") ?? 0) >= 0.9;
    const roles = [...roleScores.entries()].filter(([, score]) => score >= 0.6).map(([value]) => value);
    const tags = [...tagScores.entries()].filter(([, score]) => score >= 0.6).map(([value]) => value);

    let kind = (bestKind.value as FileClassification["kind"] | undefined) ?? "unknown";
    if (generated) {
      kind = "generated";
    } else if (kind === "unknown" && bestLanguage.value) {
      kind = roles.includes("test") ? "test" : "source";
    }

    return {
      kind,
      language: bestLanguage.value,
      roles,
      tags,
      generated,
      confidence: Math.max(bestKind.score, bestLanguage.score, 0.05),
      reasons: summarizeSignals(signals),
      signals
    };
  }
}

export function createDefaultDetectors(): DetectionModule[] {
  return [
    new PathPatternDetector(),
    new GeneratedBannerDetector(),
    new BinaryExtensionDetector(),
    new TestHeuristicsDetector(),
    new LogHeuristicsDetector(),
    new DocumentHeuristicsDetector(),
    new ConfigHeuristicsDetector()
  ];
}

export async function readCandidateText(candidate: CandidateFile, runtimeConventions: RuntimeConventions): Promise<string | undefined> {
  if (runtimeConventions.binaryExtensions.has(candidate.extension)) {
    return undefined;
  }
  return readFile(candidate.absPath, "utf8").catch(() => undefined);
}
