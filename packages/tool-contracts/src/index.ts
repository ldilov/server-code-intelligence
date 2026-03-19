import { z } from "zod";

export const toolResponseBaseSchema = z.object({
  summary: z.string(),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.unknown()),
  structured_data: z.unknown(),
  suggested_next_tools: z.array(z.string())
});

export const indexWorkspaceInputSchema = z.object({
  rootPath: z.string().min(1),
  label: z.string().min(1).optional()
});

export const workspaceScopedInputSchema = z.object({
  workspaceId: z.string().min(1)
});

export const indexStatusInputSchema = z.object({
  workspaceId: z.string().min(1).optional()
});

export const searchCodeInputSchema = workspaceScopedInputSchema.extend({
  query: z.string().min(1),
  limit: z.number().int().positive().max(50).default(10)
});

export const findSymbolInputSchema = workspaceScopedInputSchema.extend({
  symbolName: z.string().min(1)
});

export const findModuleInputSchema = workspaceScopedInputSchema.extend({
  modulePath: z.string().min(1)
});

export const moduleDependenciesInputSchema = workspaceScopedInputSchema.extend({
  modulePath: z.string().min(1),
  maxDepth: z.number().int().positive().max(10).default(3)
});

export const reverseDependenciesInputSchema = workspaceScopedInputSchema.extend({
  entityId: z.string().min(1),
  maxDepth: z.number().int().positive().max(10).default(3)
});

export const traceDependencyPathInputSchema = workspaceScopedInputSchema.extend({
  sourceModulePath: z.string().min(1),
  targetModulePath: z.string().min(1)
});

export const summarizeBranchChangesInputSchema = workspaceScopedInputSchema;

export const estimateBlastRadiusInputSchema = workspaceScopedInputSchema.extend({
  modulePath: z.string().min(1),
  maxDepth: z.number().int().positive().max(10).default(3)
});

export const analyzeTestFailuresInputSchema = workspaceScopedInputSchema.extend({
  limit: z.number().int().positive().max(50).default(10)
});

export const checkArchitectureViolationsInputSchema = workspaceScopedInputSchema.extend({
  severity: z.enum(["warning", "error"]).optional()
});

export const queryLogsInputSchema = workspaceScopedInputSchema.extend({
  pattern: z.string().min(1).optional(),
  service: z.string().min(1).optional(),
  level: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "unknown"]).optional(),
  limit: z.number().int().positive().max(100).default(20)
});

export const buildIncidentTimelineInputSchema = workspaceScopedInputSchema.extend({
  service: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100).default(20)
});

export type IndexWorkspaceInput = z.infer<typeof indexWorkspaceInputSchema>;
export type IndexStatusInput = z.infer<typeof indexStatusInputSchema>;
export type SearchCodeInput = z.infer<typeof searchCodeInputSchema>;
export type FindSymbolInput = z.infer<typeof findSymbolInputSchema>;
export type FindModuleInput = z.infer<typeof findModuleInputSchema>;
export type ModuleDependenciesInput = z.infer<typeof moduleDependenciesInputSchema>;
export type ReverseDependenciesInput = z.infer<typeof reverseDependenciesInputSchema>;
export type TraceDependencyPathInput = z.infer<typeof traceDependencyPathInputSchema>;
export type EstimateBlastRadiusInput = z.infer<typeof estimateBlastRadiusInputSchema>;
export type AnalyzeTestFailuresInput = z.infer<typeof analyzeTestFailuresInputSchema>;
export type CheckArchitectureViolationsInput = z.infer<typeof checkArchitectureViolationsInputSchema>;
export type QueryLogsInput = z.infer<typeof queryLogsInputSchema>;
export type BuildIncidentTimelineInput = z.infer<typeof buildIncidentTimelineInputSchema>;
