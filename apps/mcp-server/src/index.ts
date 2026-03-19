import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { GraphEngine } from "@local-engineering-brain/graph-engine";
import { WorkspaceIndexer } from "@local-engineering-brain/indexer";
import { RetrievalEngine } from "@local-engineering-brain/retrieval-engine";
import { createLogger, nowIso } from "@local-engineering-brain/shared-utils";
import { BrainDatabase } from "@local-engineering-brain/storage-sqlite";
import {
  analyzeTestFailuresInputSchema,
  buildIncidentTimelineInputSchema,
  checkArchitectureViolationsInputSchema,
  estimateBlastRadiusInputSchema,
  findModuleInputSchema,
  findSymbolInputSchema,
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
      version: "0.1.0"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "index_workspace",
        description: "Register and incrementally index a workspace into the local engineering graph.",
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
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      switch (name) {
        case "index_workspace": {
          const input = indexWorkspaceInputSchema.parse(args ?? {});
          const registration = await registerWorkspace(appPaths, input.rootPath, input.label);
          database.upsertWorkspace(registration.workspace);
          const result = await indexer.indexWorkspace(registration.workspace);
          return textResult({
            summary: `Indexed workspace ${registration.workspace.label}.`,
            confidence: 0.95,
            evidence: [],
            structured_data: result,
            suggested_next_tools: ["get_index_status", "search_code"]
          });
        }
        case "get_index_status": {
          const input = indexStatusInputSchema.parse(args ?? {});
          if (!input.workspaceId) {
            const approvedWorkspaces = await listApprovedWorkspaces(appPaths);
            return textResult({
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
          }
          const status = database.getIndexStatus(input.workspaceId);
          return textResult({
            summary: status.message,
            confidence: status.status === "completed" ? 0.95 : status.status === "running" ? 0.9 : 0.7,
            evidence: [],
            structured_data: status,
            suggested_next_tools: status.status === "completed" ? ["search_code", "summarize_branch_changes"] : ["index_workspace"]
          });
        }
        case "search_code": {
          const input = searchCodeInputSchema.parse(args ?? {});
          return textResult(retrieval.searchCode(input.workspaceId, input.query, input.limit));
        }
        case "find_symbol": {
          const input = findSymbolInputSchema.parse(args ?? {});
          return textResult(retrieval.findSymbol(input.workspaceId, input.symbolName));
        }
        case "find_module": {
          const input = findModuleInputSchema.parse(args ?? {});
          return textResult(retrieval.findModule(input.workspaceId, input.modulePath));
        }
        case "get_module_dependencies": {
          const input = moduleDependenciesInputSchema.parse(args ?? {});
          return textResult(retrieval.getModuleDependencies(input.workspaceId, input.modulePath, input.maxDepth));
        }
        case "get_reverse_dependencies": {
          const input = reverseDependenciesInputSchema.parse(args ?? {});
          return textResult(retrieval.getReverseDependencies(input.workspaceId, input.entityId, input.maxDepth));
        }
        case "trace_dependency_path": {
          const input = traceDependencyPathInputSchema.parse(args ?? {});
          return textResult(retrieval.traceDependencyPath(input.workspaceId, input.sourceModulePath, input.targetModulePath));
        }
        case "explain_module": {
          const input = findModuleInputSchema.parse(args ?? {});
          return textResult(retrieval.explainModule(input.workspaceId, input.modulePath));
        }
        case "summarize_branch_changes": {
          const input = workspaceScopedInputSchema.parse(args ?? {});
          return textResult(retrieval.summarizeBranchChanges(input.workspaceId));
        }
        case "estimate_blast_radius": {
          const input = estimateBlastRadiusInputSchema.parse(args ?? {});
          return textResult(retrieval.estimateBlastRadius(input.workspaceId, input.modulePath, input.maxDepth));
        }
        case "check_architecture_violations": {
          const input = checkArchitectureViolationsInputSchema.parse(args ?? {});
          return textResult(retrieval.checkArchitectureViolations(input.workspaceId, input.severity));
        }
        case "analyze_test_failures": {
          const input = analyzeTestFailuresInputSchema.parse(args ?? {});
          return textResult(retrieval.analyzeTestFailures(input.workspaceId, input.limit));
        }
        case "query_logs": {
          const input = queryLogsInputSchema.parse(args ?? {});
          return textResult(
            retrieval.queryLogs(
              input.workspaceId,
              { pattern: input.pattern, service: input.service, level: input.level },
              input.limit
            )
          );
        }
        case "build_incident_timeline": {
          const input = buildIncidentTimelineInputSchema.parse(args ?? {});
          return textResult(retrieval.buildIncidentTimeline(input.workspaceId, input.limit, input.service));
        }
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      logger.error({ err: error, tool: name }, "Tool execution failed");
      return {
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error)
          }
        ],
        isError: true
      };
    }
  });

  async function start(): Promise<void> {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }

  return {
    appPaths,
    database,
    server,
    start
  };
}
