import { readFile } from "node:fs/promises";
import path from "node:path";
import type { EdgeRecord, ModuleRecord, SymbolRecord, ToolResponse } from "@local-engineering-brain/core-types";
import { GraphEngine } from "@local-engineering-brain/graph-engine";
import { BrainDatabase } from "@local-engineering-brain/storage-sqlite";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ContextBundleOptions {
  /** Maximum approximate token budget for the entire bundle. Default: 8000. */
  tokenBudget?: number;
  /** Maximum dependency depth to include. Default: 2. */
  depth?: number;
  /** Include related test files in the bundle. Default: false. */
  includeTests?: boolean;
  /** Include reverse dependencies (who depends on this module). Default: false. */
  includeUsage?: boolean;
  /** Include recent change context from git. Default: true. */
  includeChanges?: boolean;
}

export interface ContextChunk {
  /** What kind of context this chunk provides. */
  role: "target_source" | "dependency_signature" | "dependent_signature" | "test_context" | "change_context";
  /** Module canonical path this chunk relates to. */
  modulePath: string;
  /** The actual text content. */
  content: string;
  /** Estimated token count for this chunk. */
  estimatedTokens: number;
  /** Priority rank (lower = more important, included first). */
  priority: number;
}

export interface ContextBundle {
  /** The target module this bundle was built for. */
  targetModule: ModuleRecord;
  /** Ordered chunks that fit within the token budget. */
  chunks: ContextChunk[];
  /** Total estimated tokens used. */
  totalTokens: number;
  /** Token budget that was requested. */
  tokenBudget: number;
  /** Chunks that were excluded due to budget limits. */
  excludedCount: number;
  /** Modules whose signatures were included. */
  includedModulePaths: string[];
}

// ─── Token Estimation ───────────────────────────────────────────────────────

/**
 * Simple token estimator. ~4 chars per token is a widely-used heuristic
 * for English/code text with modern tokenizers. Slightly conservative
 * (overestimates) which is safer for budget enforcement.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

// ─── Chunk Builders ─────────────────────────────────────────────────────────

function buildModuleSignature(module: ModuleRecord, symbols: SymbolRecord[]): string {
  const lines: string[] = [];
  lines.push(`// Module: ${module.canonicalPath}`);
  if (module.summary) {
    lines.push(`// ${module.summary}`);
  }

  const exported = symbols.filter((s) => s.exported);
  if (exported.length > 0) {
    lines.push(`// Public exports: ${module.publicExports.join(", ") || "(none)"}`);
    lines.push("");
    for (const sym of exported) {
      if (sym.signature) {
        lines.push(sym.signature);
      } else {
        lines.push(`${sym.kind} ${sym.qualifiedName}`);
      }
    }
  } else {
    lines.push("// No public exports");
  }

  return lines.join("\n");
}

function buildChangeContext(
  changedFiles: Array<{ path: string; status: string }>,
  recentCommits: Array<{ summary: string; authoredAt: string }>
): string {
  const lines: string[] = [];
  lines.push("// Recent changes:");

  if (recentCommits.length > 0) {
    for (const commit of recentCommits.slice(0, 3)) {
      lines.push(`//   ${commit.authoredAt.slice(0, 10)} — ${commit.summary}`);
    }
  }

  if (changedFiles.length > 0) {
    lines.push("// Changed files:");
    for (const file of changedFiles.slice(0, 10)) {
      lines.push(`//   [${file.status}] ${file.path}`);
    }
    if (changedFiles.length > 10) {
      lines.push(`//   ... and ${changedFiles.length - 10} more`);
    }
  }

  return lines.join("\n");
}

// ─── Context Bundler ────────────────────────────────────────────────────────

const DEFAULT_TOKEN_BUDGET = 8000;
const DEFAULT_DEPTH = 2;

export class ContextBundler {
  public constructor(
    private readonly database: BrainDatabase,
    private readonly graph: GraphEngine
  ) {}

  /**
   * Build a context bundle for a target module, optimized for LLM consumption.
   * Chunks are ranked by priority and packed greedily into the token budget.
   */
  public async bundle(
    workspaceId: string,
    modulePath: string,
    options: ContextBundleOptions = {}
  ): Promise<ContextBundle | null> {
    const tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    const depth = options.depth ?? DEFAULT_DEPTH;
    const includeTests = options.includeTests ?? false;
    const includeUsage = options.includeUsage ?? false;
    const includeChanges = options.includeChanges ?? true;

    const module = this.database.findModuleByPath(workspaceId, modulePath);
    if (!module) {
      return null;
    }

    const allChunks: ContextChunk[] = [];

    // Priority 1: Target module source code
    const targetSource = await this.readModuleSource(module);
    if (targetSource) {
      allChunks.push({
        role: "target_source",
        modulePath: module.canonicalPath,
        content: targetSource,
        estimatedTokens: estimateTokens(targetSource),
        priority: 1
      });
    }

    // Priority 2: Direct dependency signatures
    const deps = this.graph.getModuleDependencies(workspaceId, module.id, depth);
    const depModules = deps.modules.filter((m) => m.id !== module.id);
    for (let i = 0; i < depModules.length; i++) {
      const dep = depModules[i]!;
      const symbols = this.database.listModuleSymbols(dep.id);
      const sig = buildModuleSignature(dep, symbols);
      allChunks.push({
        role: "dependency_signature",
        modulePath: dep.canonicalPath,
        content: sig,
        estimatedTokens: estimateTokens(sig),
        // Direct deps (distance 1) get higher priority than transitive
        priority: 10 + i
      });
    }

    // Priority 3: Reverse dependency signatures (who uses this module)
    if (includeUsage) {
      const reverseDeps = this.graph.getReverseDependencies(workspaceId, module.id, 1);
      const dependents = reverseDeps.modules.filter((m) => m.id !== module.id);
      for (let i = 0; i < dependents.length; i++) {
        const dep = dependents[i]!;
        const symbols = this.database.listModuleSymbols(dep.id);
        const sig = buildModuleSignature(dep, symbols);
        allChunks.push({
          role: "dependent_signature",
          modulePath: dep.canonicalPath,
          content: sig,
          estimatedTokens: estimateTokens(sig),
          priority: 50 + i
        });
      }
    }

    // Priority 4: Test context
    if (includeTests) {
      const testCandidates = this.database.listTestCandidatesForModuleIds(workspaceId, [module.id]);
      for (let i = 0; i < testCandidates.length; i++) {
        const candidate = testCandidates[i]!;
        const testSource = await this.readFileSource(candidate.testCase.filePath);
        if (testSource) {
          allChunks.push({
            role: "test_context",
            modulePath: candidate.testCase.filePath,
            content: testSource,
            estimatedTokens: estimateTokens(testSource),
            priority: 70 + i
          });
        }
      }
    }

    // Priority 5: Change context
    if (includeChanges) {
      const changeGroup = this.database.getLatestChangeGroup(workspaceId);
      if (changeGroup) {
        const recentCommits = this.database.listRecentCommits(workspaceId, 3);
        const changeContent = buildChangeContext(
          changeGroup.changedFiles.map((f) => ({ path: f.path, status: f.status })),
          recentCommits.map((c) => ({ summary: c.summary, authoredAt: c.authoredAt }))
        );
        allChunks.push({
          role: "change_context",
          modulePath: module.canonicalPath,
          content: changeContent,
          estimatedTokens: estimateTokens(changeContent),
          priority: 90
        });
      }
    }

    // Greedy packing by priority
    allChunks.sort((a, b) => a.priority - b.priority);

    const includedChunks: ContextChunk[] = [];
    let totalTokens = 0;
    let excludedCount = 0;

    for (const chunk of allChunks) {
      if (totalTokens + chunk.estimatedTokens <= tokenBudget) {
        includedChunks.push(chunk);
        totalTokens += chunk.estimatedTokens;
      } else {
        excludedCount += 1;
      }
    }

    return {
      targetModule: module,
      chunks: includedChunks,
      totalTokens,
      tokenBudget,
      excludedCount,
      includedModulePaths: [...new Set(includedChunks.map((c) => c.modulePath))]
    };
  }

  /**
   * Build context bundle and wrap it as a ToolResponse.
   */
  public async getContextBundle(
    workspaceId: string,
    modulePath: string,
    options: ContextBundleOptions = {}
  ): Promise<ToolResponse<{ bundle: ContextBundle | null }>> {
    const result = await this.bundle(workspaceId, modulePath, options);

    if (!result) {
      return {
        summary: `No indexed module matched "${modulePath}".`,
        confidence: 0.2,
        evidence: [],
        structured_data: { bundle: null },
        suggested_next_tools: ["search_code", "find_module"]
      };
    }

    return {
      summary: `Context bundle for ${path.basename(result.targetModule.canonicalPath)}: ${result.chunks.length} chunk(s), ~${result.totalTokens} tokens (budget: ${result.tokenBudget}). ${result.excludedCount > 0 ? `${result.excludedCount} chunk(s) excluded due to budget.` : "All context included."}`,
      confidence: 0.88,
      evidence: [{
        primary: {
          entityId: result.targetModule.id,
          entityType: "module",
          label: path.basename(result.targetModule.canonicalPath),
          path: result.targetModule.canonicalPath,
          summary: result.targetModule.summary
        },
        related: result.chunks
          .filter((c) => c.role !== "target_source")
          .slice(0, 10)
          .map((c) => ({
            entityId: c.modulePath,
            entityType: "module" as const,
            label: path.basename(c.modulePath),
            path: c.modulePath,
            summary: `${c.role}: ~${c.estimatedTokens} tokens`
          })),
        edges: [],
        notes: [
          `Token budget: ${result.tokenBudget}`,
          `Tokens used: ${result.totalTokens}`,
          `Chunks included: ${result.chunks.length}`,
          `Chunks excluded: ${result.excludedCount}`
        ]
      }],
      structured_data: { bundle: result },
      suggested_next_tools: ["find_module", "get_module_dependencies", "estimate_blast_radius"]
    };
  }

  // ─── Private helpers ────────────────────────────────────────────────────

  private async readModuleSource(module: ModuleRecord): Promise<string | null> {
    const file = this.database.getFileByModuleId(module.id);
    if (!file) {
      return null;
    }
    return this.readFileSource(file.path);
  }

  private async readFileSource(filePath: string): Promise<string | null> {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      return null;
    }
  }
}
