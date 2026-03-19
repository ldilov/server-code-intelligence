import type { ArchitectureRulesConfig, ArchitectureViolationRecord, EdgeRecord, ModuleRecord } from "@local-engineering-brain/core-types";
export declare function loadArchitectureRules(workspaceRoot: string): Promise<ArchitectureRulesConfig>;
export interface ArchitectureEvaluationInput {
    workspaceId: string;
    workspaceRoot: string;
    modules: ModuleRecord[];
    importEdges: EdgeRecord[];
    config: ArchitectureRulesConfig;
}
export declare function evaluateArchitectureRules(input: ArchitectureEvaluationInput): ArchitectureViolationRecord[];
//# sourceMappingURL=index.d.ts.map