import type { ChangedFileRecord, CommitRecord } from "@local-engineering-brain/core-types";
export interface GitSnapshot {
    isRepository: boolean;
    branchName?: string;
    changedFiles: ChangedFileRecord[];
    recentCommits: CommitRecord[];
    notes: string[];
}
export type GitExecutor = (rootPath: string, args: string[]) => string;
export declare function parseStatusPorcelain(output: string): ChangedFileRecord[];
export declare function parseRecentCommits(output: string, workspaceId: string, repoId: string, branchName?: string): CommitRecord[];
export declare class GitIntelCollector {
    private readonly execute;
    constructor(execute?: GitExecutor);
    collect(rootPath: string, workspaceId: string, repoId: string, commitLimit?: number): GitSnapshot;
}
//# sourceMappingURL=index.d.ts.map