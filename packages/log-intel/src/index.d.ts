import type { IncidentRecord, LogEventRecord, LogIntelConfig, LogSourceConfig } from "@local-engineering-brain/core-types";
export declare function loadLogIntelConfig(workspaceRoot: string): Promise<LogIntelConfig>;
export declare function discoverWorkspaceLogSources(workspaceRoot: string): Promise<LogSourceConfig[]>;
export interface LogCollectionResult {
    events: LogEventRecord[];
    incidents: IncidentRecord[];
    warnings: string[];
}
export declare function collectConfiguredLogs(workspaceRoot: string, workspaceId: string, config: LogIntelConfig): Promise<LogCollectionResult>;
//# sourceMappingURL=index.d.ts.map