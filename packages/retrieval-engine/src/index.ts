import path from "node:path";
import type {
  ArchitectureViolationRecord,
  BranchChangeSummary,
  ChangedFileRecord,
  CommitRecord,
  EdgeRecord,
  EvidenceBundle,
  EvidenceReference,
  IncidentTimeline,
  LogEventRecord,
  LogLevel,
  ModuleRecord,
  PackageRecord,
  SearchHit,
  SymbolRecord,
  TestFailureAnalysis,
  ToolResponse,
  ViolationSeverity
} from "@local-engineering-brain/core-types";
import { GraphEngine } from "@local-engineering-brain/graph-engine";
import { BrainDatabase } from "@local-engineering-brain/storage-sqlite";

interface RankedSearchHit extends SearchHit {
  matchedTokens: string[];
}

// ─── Review Context Types ───────────────────────────────────────────────────

export interface ReviewModuleRisk {
  module: ModuleRecord;
  /** Number of modules that depend on this one (fan-in). */
  fanIn: number;
  /** Number of recent commits touching this module's file. */
  changeFrequency: number;
  /** Whether any test suite covers this module. */
  hasCoverage: boolean;
  /** Architecture violations introduced by this module. */
  violations: ArchitectureViolationRecord[];
  /** Computed risk score: higher = riskier. */
  riskScore: number;
}

export interface ReviewContext {
  /** Modules affected by the changes. */
  changedModules: ModuleRecord[];
  /** All modules impacted via dependency graph (reverse deps of changed). */
  impactedModules: ModuleRecord[];
  /** Per-module risk analysis, sorted by risk score descending. */
  moduleRisks: ReviewModuleRisk[];
  /** Packages containing changed modules. */
  affectedPackages: PackageRecord[];
  /** Test suites that cover changed modules. */
  testCoverage: Array<{ modulePath: string; testCount: number }>;
  /** Modules with no test coverage (gaps). */
  testGaps: string[];
  /** Architecture violations on changed modules. */
  violations: ArchitectureViolationRecord[];
  /** Recent commits for context. */
  recentCommits: CommitRecord[];
  /** Diagnostic notes. */
  notes: string[];
}

function bundle(primary: EvidenceReference, related: EvidenceReference[] = [], edges: EdgeRecord[] = [], notes: string[] = []): EvidenceBundle {
  return {
    primary,
    related,
    edges,
    notes
  };
}

function moduleReference(module: ModuleRecord, score?: number): EvidenceReference {
  return {
    entityId: module.id,
    entityType: "module",
    label: path.basename(module.canonicalPath),
    path: module.canonicalPath,
    summary: module.summary,
    score
  };
}

function symbolReference(symbol: SymbolRecord): EvidenceReference {
  return {
    entityId: symbol.id,
    entityType: "symbol",
    label: symbol.qualifiedName,
    summary: symbol.summary,
    range: symbol.range
  };
}

function logReference(event: LogEventRecord): EvidenceReference {
  return {
    entityId: event.id,
    entityType: "log_event",
    label: `${event.service} ${event.level.toUpperCase()}`,
    path: event.filePath,
    summary: event.message
  };
}

function tokenizeSearchQuery(query: string): string[] {
  return [...new Set(
    query
      .split(/\s+/)
      .flatMap((part) => part.split(/[(),:{}[\]]+/))
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
  )];
}

export class RetrievalEngine {
  public constructor(
    private readonly database: BrainDatabase,
    private readonly graph: GraphEngine
  ) {}

  public searchCode(workspaceId: string, query: string, limit: number): ToolResponse<{ hits: SearchHit[] }> {
    const hits = this.searchCodeHybrid(workspaceId, query, limit);
    return {
      summary: hits.length > 0 ? `Found ${hits.length} ranked result(s) for "${query}".` : `No code results matched "${query}".`,
      confidence: hits.length > 0 ? 0.86 : 0.25,
      evidence: hits.map((hit) =>
        bundle({
          entityId: hit.entityId,
          entityType: hit.entityType,
          label: hit.label,
          path: hit.path,
          summary: hit.summary,
          score: hit.score
        })
      ),
      structured_data: { hits },
      suggested_next_tools: hits.some((hit) => hit.entityType === "module") ? ["find_module", "get_module_dependencies"] : ["find_symbol", "find_module"]
    };
  }

  private searchCodeHybrid(workspaceId: string, query: string, limit: number): SearchHit[] {
    const queryText = query.trim();
    if (!queryText) {
      return [];
    }

    const aggregated = new Map<string, { hit: SearchHit; score: number; matchedTokens: Set<string> }>();
    const addHit = (hit: SearchHit, token: string, bonus = 0) => {
      const existing = aggregated.get(hit.entityId);
      if (!existing) {
        aggregated.set(hit.entityId, {
          hit: { ...hit },
          score: hit.score + bonus,
          matchedTokens: new Set(token.length > 0 ? [token] : [])
        });
        return;
      }

      existing.score = Math.max(existing.score, hit.score + bonus) + bonus;
      if (token.length > 0) {
        existing.matchedTokens.add(token);
      }
    };
    const safeSearch = (searchQuery: string, searchLimit: number) => {
      try {
        return this.database.search(workspaceId, searchQuery, searchLimit);
      } catch {
        return [] as SearchHit[];
      }
    };
    const addSymbolMatches = (token: string) => {
      for (const symbol of this.database.findSymbolByName(workspaceId, token)) {
        const module = this.database.getModule(symbol.moduleId);
        const symbolHit: SearchHit = {
          entityId: symbol.id,
          entityType: "symbol",
          label: symbol.qualifiedName,
          path: module?.canonicalPath ?? "",
          summary: symbol.summary,
          score: symbol.localName === token ? 0.99 : 0.82
        };
        addHit(symbolHit, token, symbol.localName === token ? 0.45 : 0.2);

        if (module) {
          addHit(
            {
              entityId: module.id,
              entityType: "module",
              label: module.canonicalPath,
              path: module.canonicalPath,
              summary: module.summary,
              score: 0.65
            },
            token,
            0.18
          );
        }
      }
    };

    for (const hit of safeSearch(queryText, limit)) {
      addHit(hit, "", 0.5);
    }

    const tokens = tokenizeSearchQuery(queryText);
    if (tokens.length > 1 || aggregated.size === 0) {
      for (const token of tokens) {
        for (const hit of safeSearch(token, Math.max(limit, 10))) {
          addHit(hit, token);
        }
        addSymbolMatches(token);
      }
    }

    return [...aggregated.values()]
      .map(({ hit, score, matchedTokens }) => ({
        ...hit,
        score: score + matchedTokens.size * 0.25,
        matchedTokens: [...matchedTokens]
      }))
      .sort((left, right) => right.matchedTokens.length - left.matchedTokens.length || right.score - left.score || left.label.localeCompare(right.label))
      .slice(0, limit)
      .map(({ matchedTokens: _matchedTokens, ...hit }) => hit);
  }

  public findSymbol(workspaceId: string, symbolName: string): ToolResponse<{ symbols: SymbolRecord[] }> {
    const symbols = this.database.findSymbolByName(workspaceId, symbolName);
    const evidence = symbols.map((symbol) => {
      const module = this.database.getModule(symbol.moduleId);
      return bundle(
        symbolReference(symbol),
        module ? [moduleReference(module)] : [],
        this.database.listEdgesFrom(workspaceId, symbol.id).slice(0, 10),
        module ? [`Declared in ${module.canonicalPath}`] : []
      );
    });

    return {
      summary: symbols.length > 0 ? `Resolved ${symbols.length} symbol candidate(s) for "${symbolName}".` : `No symbol named "${symbolName}" is indexed yet.`,
      confidence: symbols.length > 0 ? 0.88 : 0.2,
      evidence,
      structured_data: { symbols },
      suggested_next_tools: ["find_module", "estimate_blast_radius"]
    };
  }

  public findModule(workspaceId: string, modulePath: string): ToolResponse<{ module: ModuleRecord | null; symbols: SymbolRecord[] }> {
    const module = this.database.findModuleByPath(workspaceId, modulePath);
    const symbols = module ? this.database.listModuleSymbols(module.id) : [];
    return {
      summary: module ? `Resolved module ${module.canonicalPath}.` : `No indexed module matched "${modulePath}".`,
      confidence: module ? 0.92 : 0.2,
      evidence: module ? [bundle(moduleReference(module), symbols.slice(0, 8).map((symbol) => symbolReference(symbol)), this.database.listEdgesFrom(workspaceId, module.id).slice(0, 20))] : [],
      structured_data: { module: module ?? null, symbols },
      suggested_next_tools: module ? ["get_module_dependencies", "get_reverse_dependencies", "explain_module"] : ["search_code"]
    };
  }

  public explainModule(workspaceId: string, modulePath: string): ToolResponse<{ module: ModuleRecord | null; dependencies: ModuleRecord[]; dependents: ModuleRecord[] }> {
    const module = this.database.findModuleByPath(workspaceId, modulePath);
    if (!module) {
      return {
        summary: `No indexed module matched "${modulePath}".`,
        confidence: 0.2,
        evidence: [],
        structured_data: { module: null, dependencies: [], dependents: [] },
        suggested_next_tools: ["search_code"]
      };
    }

    const dependencies = this.graph.getModuleDependencies(workspaceId, module.id, 1).modules.filter((candidate) => candidate.id !== module.id);
    const dependents = this.graph.getReverseDependencies(workspaceId, module.id, 1).modules.filter((candidate) => candidate.id !== module.id);
    return {
      summary: `${path.basename(module.canonicalPath)} has ${dependencies.length} direct dependency node(s) and ${dependents.length} direct dependent node(s).`,
      confidence: 0.89,
      evidence: [bundle(moduleReference(module), [...dependencies.map((candidate) => moduleReference(candidate)), ...dependents.map((candidate) => moduleReference(candidate))], this.database.listEdgesFrom(workspaceId, module.id), [module.summary])],
      structured_data: { module, dependencies, dependents },
      suggested_next_tools: ["get_module_dependencies", "get_reverse_dependencies", "estimate_blast_radius"]
    };
  }

  public getModuleDependencies(workspaceId: string, modulePath: string, maxDepth: number): ToolResponse<{ root: ModuleRecord | null; modules: ModuleRecord[] }> {
    const module = this.database.findModuleByPath(workspaceId, modulePath);
    if (!module) {
      return {
        summary: `No indexed module matched "${modulePath}".`,
        confidence: 0.2,
        evidence: [],
        structured_data: { root: null, modules: [] },
        suggested_next_tools: ["search_code"]
      };
    }

    const traversal = this.graph.getModuleDependencies(workspaceId, module.id, maxDepth);
    const modules = traversal.modules.filter((candidate) => candidate.id !== module.id);
    return {
      summary: `${path.basename(module.canonicalPath)} reaches ${modules.length} module(s) within ${maxDepth} hop(s).`,
      confidence: 0.9,
      evidence: [bundle(moduleReference(module), modules.map((candidate) => moduleReference(candidate)), traversal.edges)],
      structured_data: { root: module, modules },
      suggested_next_tools: ["trace_dependency_path", "estimate_blast_radius"]
    };
  }

  public getReverseDependencies(workspaceId: string, entityId: string, maxDepth: number): ToolResponse<{ modules: ModuleRecord[] }> {
    const traversal = this.graph.getReverseDependencies(workspaceId, entityId, maxDepth);
    const modules = traversal.modules.filter((candidate) => candidate.id !== entityId);
    return {
      summary: `Found ${modules.length} reverse dependency module(s) within ${maxDepth} hop(s).`,
      confidence: modules.length > 0 ? 0.84 : 0.35,
      evidence: modules.map((module) => bundle(moduleReference(module), [], traversal.edges.filter((edge) => edge.sourceId === module.id || edge.targetId === module.id))),
      structured_data: { modules },
      suggested_next_tools: ["estimate_blast_radius", "trace_dependency_path"]
    };
  }

  public traceDependencyPath(workspaceId: string, sourceModulePath: string, targetModulePath: string): ToolResponse<{ path: string[] | null }> {
    const source = this.database.findModuleByPath(workspaceId, sourceModulePath);
    const target = this.database.findModuleByPath(workspaceId, targetModulePath);
    if (!source || !target) {
      return {
        summary: "Both source and target modules must already be indexed to trace a path.",
        confidence: 0.2,
        evidence: [],
        structured_data: { path: null },
        suggested_next_tools: ["find_module", "search_code"]
      };
    }

    const pathResult = this.graph.traceShortestPath(workspaceId, source.id, target.id);
    const modules = pathResult ? this.database.listModulesByIds(pathResult.moduleIds) : [];
    return {
      summary: pathResult ? `Found a ${Math.max(0, modules.length - 1)}-hop dependency path.` : `No dependency path was found between ${source.canonicalPath} and ${target.canonicalPath}.`,
      confidence: pathResult ? 0.87 : 0.3,
      evidence: pathResult ? [bundle(moduleReference(source), modules.slice(1).map((module) => moduleReference(module)), pathResult.edges)] : [],
      structured_data: { path: modules.map((module) => module.canonicalPath) },
      suggested_next_tools: ["get_module_dependencies", "get_reverse_dependencies"]
    };
  }

  public estimateBlastRadius(workspaceId: string, modulePath: string, maxDepth: number): ToolResponse<{ root: ModuleRecord | null; impacted: ModuleRecord[] }> {
    const module = this.database.findModuleByPath(workspaceId, modulePath);
    if (!module) {
      return {
        summary: `No indexed module matched "${modulePath}".`,
        confidence: 0.2,
        evidence: [],
        structured_data: { root: null, impacted: [] },
        suggested_next_tools: ["search_code"]
      };
    }

    const traversal = this.graph.getReverseDependencies(workspaceId, module.id, maxDepth);
    const impacted = traversal.modules.filter((candidate) => candidate.id !== module.id);
    return {
      summary: `${path.basename(module.canonicalPath)} has an estimated blast radius of ${impacted.length} dependent module(s) within ${maxDepth} hop(s).`,
      confidence: impacted.length > 0 ? 0.88 : 0.55,
      evidence: [bundle(moduleReference(module), impacted.map((candidate) => moduleReference(candidate)), traversal.edges)],
      structured_data: { root: module, impacted },
      suggested_next_tools: ["get_reverse_dependencies", "trace_dependency_path"]
    };
  }

  public summarizeBranchChanges(workspaceId: string): ToolResponse<BranchChangeSummary> {
    const changeGroup = this.database.getLatestChangeGroup(workspaceId);
    if (!changeGroup) {
      return {
        summary: "No persisted branch change snapshot is available yet.",
        confidence: 0.35,
        evidence: [],
        structured_data: {
          branchName: undefined,
          files: [],
          modules: [],
          packages: [],
          recentCommits: [],
          notes: ["Index the workspace to collect git metadata."]
        },
        suggested_next_tools: ["index_workspace", "get_index_status"]
      };
    }

    const modules = this.database.listModulesForChangeGroup(workspaceId, changeGroup.id);
    const packageIds = [...new Set(modules.map((module) => module.packageId).filter(Boolean))] as string[];
    const packages = this.database.listPackagesByIds(packageIds);
    const recentCommits = this.database.listRecentCommits(workspaceId, 5);
    const notes = changeGroup.changedFiles.length === 0 ? ["No branch-local changes were detected."] : [];

    return {
      summary:
        changeGroup.changedFiles.length > 0
          ? `Detected ${changeGroup.changedFiles.length} changed file(s) mapped to ${modules.length} indexed module(s).`
          : "No branch-local changes were detected.",
      confidence: changeGroup.changedFiles.length > 0 ? 0.86 : 0.55,
      evidence: modules.map((module) => bundle(moduleReference(module))),
      structured_data: {
        branchName: changeGroup.branchName,
        files: changeGroup.changedFiles,
        modules,
        packages,
        recentCommits,
        notes
      },
      suggested_next_tools: modules.length > 0 ? ["find_module", "estimate_blast_radius"] : ["index_workspace", "search_code"]
    };
  }

  public checkArchitectureViolations(
    workspaceId: string,
    severity?: ViolationSeverity
  ): ToolResponse<{ violations: ArchitectureViolationRecord[] }> {
    const violations = this.database.listArchitectureViolations(workspaceId, severity);
    const evidence = violations.map((violation) => {
      const source = this.database.getModule(violation.sourceModuleId);
      const target = this.database.getModule(violation.targetModuleId);
      const edge = violation.evidenceEdgeId ? this.database.getEdgeById(violation.evidenceEdgeId) : undefined;
      return bundle(
        {
          entityId: violation.id,
          entityType: "architecture_violation",
          label: violation.ruleId,
          path: violation.sourcePath,
          summary: violation.explanation
        },
        [source, target].filter(Boolean).map((module) => moduleReference(module!)),
        edge ? [edge] : []
      );
    });

    return {
      summary: violations.length > 0 ? `Detected ${violations.length} architecture violation(s).` : "No persisted architecture violations were found.",
      confidence: violations.length > 0 ? 0.9 : 0.65,
      evidence,
      structured_data: { violations },
      suggested_next_tools: violations.length > 0 ? ["find_module", "trace_dependency_path"] : ["search_code", "explain_module"]
    };
  }

  public analyzeTestFailures(workspaceId: string, limit: number): ToolResponse<TestFailureAnalysis> {
    const changeGroup = this.database.getLatestChangeGroup(workspaceId);
    const changedModules = changeGroup ? this.database.listModulesForChangeGroup(workspaceId, changeGroup.id) : [];
    const candidateTests = this.database.listTestCandidatesForModuleIds(
      workspaceId,
      changedModules.map((module) => module.id)
    ).slice(0, limit);
    const notes: string[] = [];

    if (!changeGroup) {
      notes.push("No persisted git change snapshot is available yet.");
    }
    if (changedModules.length === 0) {
      notes.push("No changed indexed modules were available for test correlation.");
    }
    if (candidateTests.length === 0) {
      notes.push("No deterministic test-to-module relations matched the current changed modules.");
    }

    return {
      summary:
        candidateTests.length > 0
          ? `Ranked ${candidateTests.length} candidate test(s) against ${changedModules.length} changed module(s).`
          : "No candidate tests were identified from the current changed-module set.",
      confidence: candidateTests.length > 0 ? 0.79 : 0.42,
      evidence: candidateTests.map((candidate) =>
        bundle(
          {
            entityId: candidate.testCase.id,
            entityType: "test_case",
            label: candidate.testCase.name,
            path: candidate.testCase.filePath,
            summary: `Related to ${candidate.relatedModules.length} changed module(s).`,
            score: candidate.score
          },
          [candidate.suite, ...candidate.relatedModules].map((reference) =>
            "canonicalPath" in reference ? moduleReference(reference) : {
              entityId: reference.id,
              entityType: "test_suite",
              label: reference.name,
              path: reference.filePath
            }
          )
        )
      ),
      structured_data: {
        changedModules,
        candidateTests,
        notes
      },
      suggested_next_tools: candidateTests.length > 0 ? ["summarize_branch_changes", "estimate_blast_radius"] : ["summarize_branch_changes", "find_module"]
    };
  }

  public queryLogs(
    workspaceId: string,
    filters: { pattern?: string; service?: string; level?: LogLevel },
    limit: number
  ): ToolResponse<{ events: LogEventRecord[]; incidents: ReturnType<BrainDatabase["listIncidents"]> }> {
    const events = this.database.queryLogs(workspaceId, filters, limit);
    const incidents = this.database.listIncidents(workspaceId, filters.service, limit);

    return {
      summary: events.length > 0 ? `Found ${events.length} log event(s) and ${incidents.length} incident(s).` : "No matching log events were found.",
      confidence: events.length > 0 ? 0.82 : 0.38,
      evidence: events.map((event) => bundle(logReference(event), [], [], [event.timestamp])),
      structured_data: { events, incidents },
      suggested_next_tools: events.length > 0 ? ["build_incident_timeline", "summarize_branch_changes"] : ["get_index_status", "index_workspace"]
    };
  }

  public buildIncidentTimeline(workspaceId: string, limit: number, service?: string): ToolResponse<IncidentTimeline> {
    const branchSummary = this.summarizeBranchChanges(workspaceId).structured_data;
    const testFailureAnalysis = this.analyzeTestFailures(workspaceId, Math.min(limit, 10)).structured_data;
    const incidents = this.database.listIncidents(workspaceId, service, limit);
    const logEvents = this.database.queryLogs(workspaceId, { service }, limit);
    const notes: string[] = [];

    if (incidents.length === 0) {
      notes.push("No incidents were derived from indexed logs.");
    }
    if (logEvents.length === 0) {
      notes.push("No indexed log events matched the current filters.");
    }
    if (branchSummary.modules.length === 0) {
      notes.push("No changed indexed modules were available for branch correlation.");
    }

    return {
      summary:
        incidents.length > 0
          ? `Built a local incident timeline with ${incidents.length} incident(s), ${logEvents.length} log event(s), and ${testFailureAnalysis.candidateTests.length} candidate test(s).`
          : "No local incident timeline could be built from the current indexed evidence.",
      confidence: incidents.length > 0 || logEvents.length > 0 ? 0.77 : 0.33,
      evidence: [
        ...logEvents.map((event) => bundle(logReference(event), [], [], [event.timestamp])),
        ...testFailureAnalysis.candidateTests.slice(0, 5).map((candidate) =>
          bundle(
            {
              entityId: candidate.testCase.id,
              entityType: "test_case",
              label: candidate.testCase.name,
              path: candidate.testCase.filePath,
              summary: `Candidate regression test with score ${candidate.score}.`
            },
            candidate.relatedModules.map((module) => moduleReference(module))
          )
        )
      ].slice(0, limit),
      structured_data: {
        branchSummary,
        testFailureAnalysis,
        incidents,
        logEvents,
        notes
      },
      suggested_next_tools: incidents.length > 0 ? ["query_logs", "analyze_test_failures", "summarize_branch_changes"] : ["query_logs", "summarize_branch_changes"]
    };
  }

  // ─── Code Review Context ────────────────────────────────────────────────

  public getReviewContext(workspaceId: string): ToolResponse<ReviewContext> {
    const notes: string[] = [];

    // 1. Get changed modules from the latest change group
    const changeGroup = this.database.getLatestChangeGroup(workspaceId);
    if (!changeGroup) {
      return {
        summary: "No branch change data available. Index the workspace first.",
        confidence: 0.2,
        evidence: [],
        structured_data: {
          changedModules: [],
          impactedModules: [],
          moduleRisks: [],
          affectedPackages: [],
          testCoverage: [],
          testGaps: [],
          violations: [],
          recentCommits: [],
          notes: ["No persisted git change snapshot available."]
        },
        suggested_next_tools: ["index_workspace"]
      };
    }

    const changedModules = this.database.listModulesForChangeGroup(workspaceId, changeGroup.id);
    if (changedModules.length === 0) {
      notes.push("No indexed modules matched the changed files.");
    }

    // 2. Compute impact: reverse dependencies of all changed modules
    const impactedSet = new Map<string, ModuleRecord>();
    for (const module of changedModules) {
      const traversal = this.graph.getReverseDependencies(workspaceId, module.id, 2);
      for (const impacted of traversal.modules) {
        if (impacted.id !== module.id) {
          impactedSet.set(impacted.id, impacted);
        }
      }
    }
    const impactedModules = [...impactedSet.values()];

    // 3. Test coverage analysis
    const testCoverage: ReviewContext["testCoverage"] = [];
    const testGaps: string[] = [];
    const coverageByModuleId = new Map<string, number>();

    for (const module of changedModules) {
      const candidates = this.database.listTestCandidatesForModuleIds(workspaceId, [module.id]);
      coverageByModuleId.set(module.id, candidates.length);
      if (candidates.length > 0) {
        testCoverage.push({ modulePath: module.canonicalPath, testCount: candidates.length });
      } else {
        testGaps.push(module.canonicalPath);
      }
    }

    // 4. Architecture violations on changed modules
    const allViolations = this.database.listArchitectureViolations(workspaceId);
    const changedModuleIds = new Set(changedModules.map((m) => m.id));
    const violations = allViolations.filter(
      (v) => changedModuleIds.has(v.sourceModuleId) || changedModuleIds.has(v.targetModuleId)
    );

    // 5. Affected packages
    const packageIds = [...new Set(changedModules.map((m) => m.packageId).filter(Boolean))] as string[];
    const affectedPackages = this.database.listPackagesByIds(packageIds);

    // 6. Recent commits
    const recentCommits = this.database.listRecentCommits(workspaceId, 10);

    // 7. Per-module risk scoring
    const moduleRisks: ReviewModuleRisk[] = changedModules.map((module) => {
      const reverseDeps = this.graph.getReverseDependencies(workspaceId, module.id, 1);
      const fanIn = reverseDeps.modules.filter((m) => m.id !== module.id).length;
      const hasCoverage = (coverageByModuleId.get(module.id) ?? 0) > 0;
      const moduleViolations = violations.filter((v) => v.sourceModuleId === module.id);

      // Heuristic: commits touching this file indicate change frequency
      const changeFrequency = recentCommits.length; // simplified — ideally per-file

      // Risk formula: fanIn * changeFrequency * coverage penalty * violation penalty
      const coveragePenalty = hasCoverage ? 0.5 : 1.0;
      const violationPenalty = 1.0 + moduleViolations.length * 0.3;
      const riskScore = Math.round((fanIn + 1) * (1 + changeFrequency * 0.1) * coveragePenalty * violationPenalty * 100) / 100;

      return {
        module,
        fanIn,
        changeFrequency,
        hasCoverage,
        violations: moduleViolations,
        riskScore
      };
    }).sort((a, b) => b.riskScore - a.riskScore);

    // Build evidence bundles
    const evidence = moduleRisks.slice(0, 10).map((risk) =>
      bundle(
        moduleReference(risk.module, risk.riskScore),
        [],
        [],
        [
          `Fan-in: ${risk.fanIn}`,
          `Coverage: ${risk.hasCoverage ? "yes" : "NO"}`,
          `Violations: ${risk.violations.length}`,
          `Risk score: ${risk.riskScore}`
        ]
      )
    );

    return {
      summary: `Review context: ${changedModules.length} changed module(s), ${impactedModules.length} impacted, ${testGaps.length} test gap(s), ${violations.length} violation(s).`,
      confidence: changedModules.length > 0 ? 0.85 : 0.3,
      evidence,
      structured_data: {
        changedModules,
        impactedModules,
        moduleRisks,
        affectedPackages,
        testCoverage,
        testGaps,
        violations,
        recentCommits,
        notes
      },
      suggested_next_tools: testGaps.length > 0
        ? ["analyze_test_failures", "estimate_blast_radius", "check_architecture_violations"]
        : ["estimate_blast_radius", "check_architecture_violations"]
    };
  }
}
