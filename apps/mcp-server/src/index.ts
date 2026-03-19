import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ContextBundler } from "@local-engineering-brain/context-bundler";
import { GraphEngine } from "@local-engineering-brain/graph-engine";
import { WorkspaceIndexer } from "@local-engineering-brain/indexer";
import { RetrievalEngine } from "@local-engineering-brain/retrieval-engine";
import { RetrospectBuffer } from "@local-engineering-brain/retrospect-log";
import { createLogger, nowIso } from "@local-engineering-brain/shared-utils";
import { BrainDatabase } from "@local-engineering-brain/storage-sqlite";
import {
  analyzeTestFailuresInputSchema,
  buildIncidentTimelineInputSchema,
  checkArchitectureViolationsInputSchema,
  estimateBlastRadiusInputSchema,
  findModuleInputSchema,
  findSymbolInputSchema,
  flushRetrospectLogInputSchema,
  getContextBundleInputSchema,
  getRetrospectLogInputSchema,
  getReviewContextInputSchema,
  indexChangedInputSchema,
  indexStatusInputSchema,
  indexWorkspaceInputSchema,
  moduleDependenciesInputSchema,
  queryLogsInputSchema,
  reverseDependenciesInputSchema,
  searchCodeInputSchema,
  traceDependencyPathInputSchema,
  workspaceScopedInputSchema
} from "@local-engineering-brain/tool-contracts";
import { listApprovedWorkspaces, registerWorkspace, resolveAppPaths, type AppPaths } from "@local-engineering-brain/workspace-manager";

export interface ServerOptions {
  appPaths?: AppPaths;
  bootstrapWorkspace?: string;
}

function textResult(payload: unknown) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ],
    structuredContent: payload
  };
}

export async function createLocalEngineeringBrainServer(options: ServerOptions = {}) {
  const logger = createLogger();
  const appPaths = options.appPaths ?? resolveAppPaths();
  const database = new BrainDatabase(appPaths.databasePath);
  database.init();
  const graph = new GraphEngine(database);
  const indexer = new WorkspaceIndexer(database);
  const retrieval = new RetrievalEngine(database, graph);
  const contextBundler = new ContextBundler(database, graph);
  const retrospect = new RetrospectBuffer({ maxEntries: 500 });

  if (options.bootstrapWorkspace) {
    const registration = await registerWorkspace(appPaths, options.bootstrapWorkspace);
    database.upsertWorkspace({
      ...registration.workspace,
      updatedAt: nowIso()
    });
    await indexer.indexWorkspace(registration.workspace);
  }

  const server = new Server(
    {
      name: "local-engineering-brain",
      version: "0.2.0"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      // ─── Existing tools ─────────────────────────────────────────────
      {
        name: "index_workspace",
        description: "Register and fully index a workspace into the local engineering graph.",
        inputSchema: {
          type: "object",
          properties: {
            rootPath: { type: "string" },
            label: { type: "string" }
          },
          required: ["rootPath"]
        }
      },
      {
        name: "index_changed",
        description: "Fast incremental re-index: only re-process files changed according to git status. Much faster than index_workspace for iterative development. Requires at least one prior full index.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: { type: "string" }
          },
          required: ["workspaceId"]
        }
      },
      {
        name: "get_index_status",
        description: "Return the latest workspace indexing status and progress snapshot.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: { type: "string" }
          }
        }
      },
      {
        name: "search_code",
        description: "Run ranked lexical search across files, modules, and symbols.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: { type: "string" },
            query: { type: "string" },
            limit: { type: "number" }
          },
          required: ["workspaceId", "query"]
        }
      },
      {
        name: "find_symbol",
        description: "Return canonical symbol definitions and nearby graph context.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: { type: "string" },
            symbolName: { type: "string" }
          },
          required: ["workspaceId", "symbolName"]
        }
      },
      {
        name: "find_module",
        description: "Resolve an indexed module and return its public surface.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: { type: "string" },
            modulePath: { type: "string" }
          },
          required: ["workspaceId", "modulePath"]
        }
      },
      {
        name: "get_module_dependencies",
        description: "Return bounded transitive dependencies for a module.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: { type: "string" },
            modulePath: { type: "string" },
            maxDepth: { type: "number" }
          },
          required: ["workspaceId", "modulePath"]
        }
      },
      {
        name: "get_reverse_dependencies",
        description: "Return reverse dependencies for a module identifier.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: { type: "string" },
            entityId: { type: "string" },
            maxDepth: { type: "number" }
          },
          required: ["workspaceId", "entityId"]
        }
      },
      {
        name: "trace_dependency_path",
        description: "Explain the shortest dependency path between two modules.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: { type: "string" },
            sourceModulePath: { type: "string" },
            targetModulePath: { type: "string" }
          },
          required: ["workspaceId", "sourceModulePath", "targetModulePath"]
        }
      },
      {
        name: "explain_module",
        description: "Explain a module's responsibility and direct neighborhood.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: { type: "string" },
            modulePath: { type: "string" }
          },
          required: ["workspaceId", "modulePath"]
        }
      },
      {
        name: "summarize_branch_changes",
        description: "Summarize branch-local changed files mapped to indexed modules.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: { type: "string" }
          },
          required: ["workspaceId"]
        }
      },
      {
        name: "estimate_blast_radius",
        description: "Estimate which modules are impacted by changing a module.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: { type: "string" },
            modulePath: { type: "string" },
            maxDepth: { type: "number" }
          },
          required: ["workspaceId", "modulePath"]
        }
      },
      {
        name: "check_architecture_violations",
        description: "Return persisted architecture-rule violations for an indexed workspace.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: { type: "string" },
            severity: { type: "string", enum: ["warning", "error"] }
          },
          required: ["workspaceId"]
        }
      },
      {
        name: "analyze_test_failures",
        description: "Rank likely impacted tests based on changed modules and deterministic test relations.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: { type: "string" },
            limit: { type: "number" }
          },
          required: ["workspaceId"]
        }
      },
      {
        name: "query_logs",
        description: "Search indexed logs with optional service, level, and pattern filters.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: { type: "string" },
            pattern: { type: "string" },
            service: { type: "string" },
            level: { type: "string", enum: ["trace", "debug", "info", "warn", "error", "fatal", "unknown"] },
            limit: { type: "number" }
          },
          required: ["workspaceId"]
        }
      },
      {
        name: "build_incident_timeline",
        description: "Combine branch changes, candidate tests, incidents, and recent logs into a local timeline.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: { type: "string" },
            service: { type: "string" },
            limit: { type: "number" }
          },
          required: ["workspaceId"]
        }
      },

      // ─── Phase 1: New tools ─────────────────────────────────────────
      {
        name: "get_context_bundle",
        description: "Build a token-budget-aware context bundle for a module, including source code, dependency signatures, test context, and change history. Designed for LLM consumption — returns ranked chunks that fit within the specified token budget.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: { type: "string" },
            modulePath: { type: "string" },
            tokenBudget: { type: "number", description: "Maximum token budget (default: 8000, max: 128000)" },
            depth: { type: "number", description: "Dependency depth (default: 2, max: 5)" },
            includeTests: { type: "boolean", description: "Include related test files (default: false)" },
            includeUsage: { type: "boolean", description: "Include reverse dependencies (default: false)" },
            includeChanges: { type: "boolean", description: "Include recent change context (default: true)" }
          },
          required: ["workspaceId", "modulePath"]
        }
      },
      {
        name: "get_review_context",
        description: "Comprehensive code review context: changed modules, dependency impact, test coverage gaps, architecture violations, and per-module risk scores. Uses current branch changes or a provided diff.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: { type: "string" },
            diff: { type: "string", description: "Optional raw diff text. If omitted, uses current branch changes." }
          },
          required: ["workspaceId"]
        }
      },
      {
        name: "get_retrospect_log",
        description: "Query the in-memory tool invocation log for this session. Use for self-reflection: see which tools were called, their inputs, outputs, timing, and success/failure status. Supports filtering by tool name, success state, and workspace.",
        inputSchema: {
          type: "object",
          properties: {
            toolName: { type: "string", description: "Filter by tool name" },
            success: { type: "boolean", description: "Filter by success/failure" },
            workspaceId: { type: "string", description: "Filter by workspace" },
            sinceSeq: { type: "number", description: "Only entries after this sequence number" },
            limit: { type: "number", description: "Max entries to return (default: 50)" }
          }
        }
      },
      {
        name: "flush_retrospect_log",
        description: "Export the tool invocation log as a Markdown or JSON document. Optionally clear the buffer after export. Use for retrospective analysis of tool usage patterns during a session.",
        inputSchema: {
          type: "object",
          properties: {
            clear: { type: "boolean", description: "Clear buffer after flush (default: false)" },
            toolName: { type: "string", description: "Filter to a specific tool" },
            format: { type: "string", enum: ["markdown", "json"], description: "Output format (default: markdown)" }
          }
        }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const callStart = performance.now();
    let success = true;
    let errorMsg: string | undefined;
    let result: ReturnType<typeof textResult>;

    try {
      switch (name) {
        case "index_workspace": {
          const input = indexWorkspaceInputSchema.parse(args ?? {});
          const registration = await registerWorkspace(appPaths, input.rootPath, input.label);
          database.upsertWorkspace(registration.workspace);
          const indexResult = await indexer.indexWorkspace(registration.workspace);
          result = textResult({
            summary: `Indexed workspace ${registration.workspace.label}.`,
            confidence: 0.95,
            evidence: [],
            structured_data: indexResult,
            suggested_next_tools: ["get_index_status", "search_code"]
          });
          break;
        }
        case "index_changed": {
          const input = indexChangedInputSchema.parse(args ?? {});
          const workspace = database.getWorkspace(input.workspaceId);
          if (!workspace) {
            throw new Error(`Workspace ${input.workspaceId} not found. Run index_workspace first.`);
          }
          const indexResult = await indexer.indexChanged(workspace);
          result = textResult({
            summary: `Incremental index: ${indexResult.filesIndexed} file(s) re-indexed, ${indexResult.filesSkipped} skipped.`,
            confidence: 0.92,
            evidence: [],
            structured_data: indexResult,
            suggested_next_tools: ["search_code", "summarize_branch_changes", "get_review_context"]
          });
          break;
        }
        case "get_index_status": {
          const input = indexStatusInputSchema.parse(args ?? {});
          if (!input.workspaceId) {
            const approvedWorkspaces = await listApprovedWorkspaces(appPaths);
            result = textResult({
              summary:
                approvedWorkspaces.length > 0
                  ? `Server is running in permission-safe mode with ${approvedWorkspaces.length} approved workspace(s).`
                  : "Server is running in permission-safe mode with no approved workspaces.",
              confidence: 1,
              evidence: [],
              structured_data: {
                safeDefaultMode: true,
                approvedWorkspaceCount: approvedWorkspaces.length,
                approvedWorkspaces,
                message:
                  approvedWorkspaces.length > 0
                    ? `Server is running in permission-safe mode with ${approvedWorkspaces.length} approved workspace(s).`
                    : "Server is running in permission-safe mode with no approved workspaces."
              },
              suggested_next_tools: approvedWorkspaces.length > 0 ? ["index_workspace", "search_code"] : ["index_workspace"]
            });
          } else {
            const status = database.getIndexStatus(input.workspaceId);
            result = textResult({
              summary: status.message,
              confidence: status.status === "completed" ? 0.95 : status.status === "running" ? 0.9 : 0.7,
              evidence: [],
              structured_data: status,
              suggested_next_tools: status.status === "completed" ? ["search_code", "summarize_branch_changes"] : ["index_workspace"]
            });
          }
          break;
        }
        case "search_code": {
          const input = searchCodeInputSchema.parse(args ?? {});
          result = textResult(retrieval.searchCode(input.workspaceId, input.query, input.limit));
          break;
        }
        case "find_symbol": {
          const input = findSymbolInputSchema.parse(args ?? {});
          result = textResult(retrieval.findSymbol(input.workspaceId, input.symbolName));
          break;
        }
        case "find_module": {
          const input = findModuleInputSchema.parse(args ?? {});
          result = textResult(retrieval.findModule(input.workspaceId, input.modulePath));
          break;
        }
        case "get_module_dependencies": {
          const input = moduleDependenciesInputSchema.parse(args ?? {});
          result = textResult(retrieval.getModuleDependencies(input.workspaceId, input.modulePath, input.maxDepth));
          break;
        }
        case "get_reverse_dependencies": {
          const input = reverseDependenciesInputSchema.parse(args ?? {});
          result = textResult(retrieval.getReverseDependencies(input.workspaceId, input.entityId, input.maxDepth));
          break;
        }
        case "trace_dependency_path": {
          const input = traceDependencyPathInputSchema.parse(args ?? {});
          result = textResult(retrieval.traceDependencyPath(input.workspaceId, input.sourceModulePath, input.targetModulePath));
          break;
        }
        case "explain_module": {
          const input = findModuleInputSchema.parse(args ?? {});
          result = textResult(retrieval.explainModule(input.workspaceId, input.modulePath));
          break;
        }
        case "summarize_branch_changes": {
          const input = workspaceScopedInputSchema.parse(args ?? {});
          result = textResult(retrieval.summarizeBranchChanges(input.workspaceId));
          break;
        }
        case "estimate_blast_radius": {
          const input = estimateBlastRadiusInputSchema.parse(args ?? {});
          result = textResult(retrieval.estimateBlastRadius(input.workspaceId, input.modulePath, input.maxDepth));
          break;
        }
        case "check_architecture_violations": {
          const input = checkArchitectureViolationsInputSchema.parse(args ?? {});
          result = textResult(retrieval.checkArchitectureViolations(input.workspaceId, input.severity));
          break;
        }
        case "analyze_test_failures": {
          const input = analyzeTestFailuresInputSchema.parse(args ?? {});
          result = textResult(retrieval.analyzeTestFailures(input.workspaceId, input.limit));
          break;
        }
        case "query_logs": {
          const input = queryLogsInputSchema.parse(args ?? {});
          result = textResult(
            retrieval.queryLogs(
              input.workspaceId,
              { pattern: input.pattern, service: input.service, level: input.level },
              input.limit
            )
          );
          break;
        }
        case "build_incident_timeline": {
          const input = buildIncidentTimelineInputSchema.parse(args ?? {});
          result = textResult(retrieval.buildIncidentTimeline(input.workspaceId, input.limit, input.service));
          break;
        }

        // ─── Phase 1: New tool handlers ───────────────────────────────
        case "get_context_bundle": {
          const input = getContextBundleInputSchema.parse(args ?? {});
          const bundleResult = await contextBundler.getContextBundle(input.workspaceId, input.modulePath, {
            tokenBudget: input.tokenBudget,
            depth: input.depth,
            includeTests: input.includeTests,
            includeUsage: input.includeUsage,
            includeChanges: input.includeChanges
          });
          result = textResult(bundleResult);
          break;
        }
        case "get_review_context": {
          const input = getReviewContextInputSchema.parse(args ?? {});
          result = textResult(retrieval.getReviewContext(input.workspaceId));
          break;
        }
        case "get_retrospect_log": {
          const input = getRetrospectLogInputSchema.parse(args ?? {});
          const snapshot = retrospect.snapshot({
            toolName: input.toolName,
            success: input.success,
            workspaceId: input.workspaceId,
            sinceSeq: input.sinceSeq,
            limit: input.limit
          });
          result = textResult({
            summary: `Retrospect log: ${snapshot.entries.length} entries, ${snapshot.stats.totalCalls} total calls this session.`,
            confidence: 1,
            evidence: [],
            structured_data: snapshot,
            suggested_next_tools: ["flush_retrospect_log"]
          });
          break;
        }
        case "flush_retrospect_log": {
          const input = flushRetrospectLogInputSchema.parse(args ?? {});
          const filter = input.toolName ? { toolName: input.toolName } : undefined;

          let output: string;
          if (input.format === "json") {
            output = JSON.stringify(retrospect.snapshot(filter), null, 2);
          } else {
            output = retrospect.toMarkdown(filter);
          }

          if (input.clear) {
            retrospect.clear();
          }

          result = textResult({
            summary: `Flushed retrospect log (${input.format} format, ${input.clear ? "buffer cleared" : "buffer retained"}).`,
            confidence: 1,
            evidence: [],
            structured_data: { content: output, format: input.format, cleared: input.clear },
            suggested_next_tools: ["get_retrospect_log"]
          });
          break;
        }
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      success = false;
      errorMsg = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, tool: name }, "Tool execution failed");

      // Record failed invocations too
      const durationMs = performance.now() - callStart;
      retrospect.record(
        name,
        (args && typeof args === "object" ? args : {}) as Record<string, unknown>,
        undefined,
        false,
        durationMs,
        errorMsg
      );

      return {
        content: [
          {
            type: "text",
            text: errorMsg
          }
        ],
        isError: true
      };
    }

    // Record successful invocations
    const durationMs = performance.now() - callStart;
    retrospect.record(
      name,
      (args && typeof args === "object" ? args : {}) as Record<string, unknown>,
      result.structuredContent,
      true,
      durationMs,
      undefined,
      (result.structuredContent as Record<string, unknown> | undefined)?.suggested_next_tools as string[] | undefined
    );

    return result;
  });

  async function start(): Promise<void> {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }

  return {
    appPaths,
    database,
    server,
    retrospect,
    start
  };
}
